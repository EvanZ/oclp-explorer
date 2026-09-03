"""Rebuildable DuckDB read model for CYCLOPS run navigation."""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

import duckdb

from oclp_explorer.graph import OclpProjectGraph


class CyclopsRunIndex:
    """Persistent navigation index derived solely from immutable OCLP records.

    This is intentionally CYCLOPS implementation metadata.  OCLP records and
    application-owned manifest Artifacts remain the durable source of truth;
    deleting this database is safe because :meth:`rebuild` recreates it.
    """

    def __init__(self, database: Path | str) -> None:
        self.path = Path(database)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = duckdb.connect(str(self.path))
        self._initialize()

    def close(self) -> None:
        """Close the local, single-process read-model database."""

        self._connection.close()

    def __enter__(self) -> CyclopsRunIndex:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def rebuild(self, graph: OclpProjectGraph) -> None:
        """Replace the index with the current lifecycle-run projection."""

        runs = graph.runs_payload()["runs"]
        inference_services = graph.inference_services_payload()
        run_rows: list[tuple[object, ...]] = []
        member_rows: list[tuple[object, ...]] = []
        artifact_rows: list[tuple[object, ...]] = []
        run_lineages: dict[str, str] = {}
        run_by_execution: dict[str, str] = {}

        for sort_order, run in enumerate(runs):
            root_digest = str(run["id"])
            # A lineage can contain several independently started lifecycle
            # runs joined by an Artifact handoff. This stable lexical key is
            # implementation-only; the profile run ID remains public.
            lineage_id = min(graph.run_lineage_roots(root_digest))
            run_lineages[root_digest] = lineage_id
            run_rows.append(
                (
                    root_digest,
                    lineage_id,
                    str(run["record_id"]),
                    str(run["label"]),
                    json.dumps(run["timeline"]),
                    int(run["execution_count"]),
                    int(run["artifact_count"]),
                    sort_order,
                )
            )
            execution_digests = {
                str(execution["id"])
                for execution in run["executions"]  # type: ignore[index]
            }
            for member_order, execution in enumerate(run["executions"]):  # type: ignore[index]
                run_by_execution[str(execution["id"])] = root_digest
                member_rows.append(
                    (
                        root_digest,
                        str(execution["id"]),
                        str(execution["record_id"]),
                        str(execution["label"]),
                        int(execution["depth"]),
                        str(execution["status"]),
                        json.dumps(execution["diagnostic"])
                        if execution["diagnostic"] is not None
                        else None,
                        member_order,
                    )
                )
            run_graph = graph.graph_payload(view="run", run=root_digest)
            for edge in run_graph["edges"]:  # type: ignore[index]
                if edge["relation"] == "consumes" and edge["target"] in execution_digests:
                    execution_digest, artifact_digest, direction = (
                        edge["target"],
                        edge["source"],
                        "input",
                    )
                elif edge["relation"] == "produces" and edge["source"] in execution_digests:
                    execution_digest, artifact_digest, direction = (
                        edge["source"],
                        edge["target"],
                        "output",
                    )
                else:
                    continue
                if graph.records[artifact_digest].kind == "artifact":
                    artifact_rows.append(
                        (root_digest, execution_digest, artifact_digest, direction)
                    )

        service_rows: list[tuple[object, ...]] = []
        service_member_rows: list[tuple[object, ...]] = []
        for service in inference_services:
            execution_ids = [str(value) for value in service["execution_ids"]]  # type: ignore[index]
            root_digests = {
                run_by_execution[execution_id]
                for execution_id in execution_ids
                if execution_id in run_by_execution
            }
            lineage_ids = {run_lineages[root_digest] for root_digest in root_digests}
            # A release-backed service belongs below one connected lineage. If
            # malformed records span unrelated lineage components, retain the
            # raw request runs rather than inventing a cross-lineage group.
            if len(lineage_ids) != 1:
                continue
            service_id = str(service["id"])
            service_rows.append(
                (
                    service_id,
                    next(iter(lineage_ids)),
                    str(service["release_digest"]),
                    str(service["release_id"]),
                    str(service["label"]),
                    json.dumps(service["timeline"]),
                    len(execution_ids),
                )
            )
            for member_order, execution_id in enumerate(execution_ids):
                root_digest = run_by_execution.get(execution_id)
                if root_digest is None:
                    continue
                service_member_rows.append(
                    (service_id, root_digest, execution_id, member_order)
                )

        self._connection.execute("BEGIN TRANSACTION")
        try:
            self._connection.execute("DELETE FROM cyclops_inference_service_members")
            self._connection.execute("DELETE FROM cyclops_inference_services")
            self._connection.execute("DELETE FROM cyclops_run_artifacts")
            self._connection.execute("DELETE FROM cyclops_run_members")
            self._connection.execute("DELETE FROM cyclops_runs")
            if run_rows:
                self._connection.executemany(
                    """
                    INSERT INTO cyclops_runs
                        (root_digest, lineage_id, record_id, label, timeline, execution_count,
                         artifact_count, sort_order)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    run_rows,
                )
            if member_rows:
                self._connection.executemany(
                    """
                    INSERT INTO cyclops_run_members
                        (root_digest, execution_digest, record_id, label, depth,
                         status, diagnostic, member_order)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    member_rows,
                )
            if artifact_rows:
                self._connection.executemany(
                    """
                    INSERT INTO cyclops_run_artifacts
                        (root_digest, execution_digest, artifact_digest, direction)
                    VALUES (?, ?, ?, ?)
                    """,
                    artifact_rows,
                )
            if service_rows:
                self._connection.executemany(
                    """
                    INSERT INTO cyclops_inference_services
                        (service_id, lineage_id, release_digest, release_id, label,
                         timeline, request_count)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    service_rows,
                )
            if service_member_rows:
                self._connection.executemany(
                    """
                    INSERT INTO cyclops_inference_service_members
                        (service_id, root_digest, execution_digest, member_order)
                    VALUES (?, ?, ?, ?)
                    """,
                    service_member_rows,
                )
        except Exception:
            self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")

    def runs_payload(self) -> dict[str, object]:
        """Return the API tree model straight from the persistent read model.

        ``runs`` remains available for small consumers, while ``lineages`` is
        the navigation projection: a connected group of one or more lifecycle
        runs joined by explicit produced-and-consumed Artifact handoffs.
        """

        members_by_run: dict[str, list[dict[str, object]]] = {}
        for row in self._connection.execute(
            """
            SELECT root_digest, execution_digest, record_id, label, depth,
                   status, diagnostic
            FROM cyclops_run_members
            ORDER BY root_digest, member_order, record_id
            """
        ).fetchall():
            members_by_run.setdefault(row[0], []).append(
                {
                    "id": row[1],
                    "record_id": row[2],
                    "label": row[3],
                    "depth": row[4],
                    "status": row[5],
                    "diagnostic": _decode_diagnostic(row[6]),
                }
            )
        runs = []
        lineages_by_id: dict[str, list[dict[str, object]]] = {}
        for row in self._connection.execute(
            """
            SELECT root_digest, COALESCE(lineage_id, root_digest), record_id, label,
                   timeline, execution_count, artifact_count
            FROM cyclops_runs
            ORDER BY sort_order
            """
        ).fetchall():
            members = members_by_run.get(row[0], [])
            status_members = members
            run = {
                "id": row[0],
                "record_id": row[2],
                "label": row[3],
                "timeline": json.loads(row[4]),
                "execution_count": row[5],
                "artifact_count": row[6],
                "status_counts": dict(
                    sorted(Counter(str(member["status"]) for member in status_members).items())
                ),
                "executions": members,
            }
            runs.append(run)
            lineages_by_id.setdefault(str(row[1]), []).append(run)

        service_requests: dict[str, list[dict[str, object]]] = {}
        service_run_ids: dict[str, set[str]] = {}
        for row in self._connection.execute(
            """
            SELECT service_id, root_digest, execution_digest
            FROM cyclops_inference_service_members
            ORDER BY service_id, member_order
            """
        ).fetchall():
            execution = next(
                (
                    member
                    for member in members_by_run.get(str(row[1]), [])
                    if member["id"] == row[2]
                ),
                None,
            )
            if execution is None:
                continue
            service_requests.setdefault(str(row[0]), []).append(
                {**execution, "run_id": row[1]}
            )
            service_run_ids.setdefault(str(row[0]), set()).add(str(row[1]))

        services_by_lineage: dict[str, list[dict[str, object]]] = {}
        for row in self._connection.execute(
            """
            SELECT service_id, lineage_id, release_digest, release_id, label,
                   timeline, request_count
            FROM cyclops_inference_services
            ORDER BY label, service_id
            """
        ).fetchall():
            requests = service_requests.get(str(row[0]), [])
            services_by_lineage.setdefault(str(row[1]), []).append(
                {
                    "id": row[0],
                    "release_digest": row[2],
                    "release_id": row[3],
                    "label": row[4],
                    "timeline": json.loads(row[5]),
                    "request_count": row[6],
                    "status_counts": dict(
                        sorted(Counter(str(request["status"]) for request in requests).items())
                    ),
                    "requests": requests,
                }
            )

        lineages = []
        for lineage_id, lineage_runs in lineages_by_id.items():
            services = services_by_lineage.get(lineage_id, [])
            service_run_ids_for_lineage = {
                run_id
                for service in services
                for run_id in service_run_ids.get(str(service["id"]), set())
            }
            presentation_runs = [
                run for run in lineage_runs if str(run["id"]) not in service_run_ids_for_lineage
            ]
            lineages.append(
                {
                    "id": lineage_id,
                    "label": _lineage_label(presentation_runs or lineage_runs),
                    "root_count": len(presentation_runs),
                    "execution_count": sum(
                        int(run["execution_count"]) for run in lineage_runs
                    ),
                    "artifact_count": sum(int(run["artifact_count"]) for run in lineage_runs),
                    "status_counts": dict(
                        sorted(_combined_status_counts(lineage_runs).items())
                    ),
                    "runs": presentation_runs,
                    "inference_services": services,
                }
            )
        return {"runs": runs, "lineages": lineages}

    def summary(self) -> dict[str, int]:
        """Expose index counts without making them protocol-level facts."""

        return {
            "run_count": self._count("cyclops_runs"),
            "run_member_count": self._count("cyclops_run_members"),
            "run_artifact_count": self._count("cyclops_run_artifacts"),
        }

    def _count(self, table: str) -> int:
        return int(self._connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])

    def _initialize(self) -> None:
        # This is a rebuildable projection, not an OCLP store.  Dropping the
        # former Invocation-named layout is the safest migration: every API
        # process repopulates it from immutable Computation/Execution records.
        self._connection.execute("DROP TABLE IF EXISTS cyclops_run_artifacts")
        self._connection.execute("DROP TABLE IF EXISTS cyclops_run_members")
        self._connection.execute("DROP TABLE IF EXISTS cyclops_runs")
        self._connection.execute("DROP TABLE IF EXISTS cyclops_inference_service_members")
        self._connection.execute("DROP TABLE IF EXISTS cyclops_inference_services")
        self._connection.execute(
            """
            CREATE TABLE IF NOT EXISTS cyclops_runs (
                root_digest VARCHAR PRIMARY KEY,
                lineage_id VARCHAR,
                record_id VARCHAR NOT NULL,
                label VARCHAR NOT NULL,
                timeline VARCHAR,
                execution_count INTEGER NOT NULL,
                artifact_count INTEGER NOT NULL,
                sort_order INTEGER NOT NULL
            )
            """
        )
        self._connection.execute(
            """
            CREATE TABLE IF NOT EXISTS cyclops_inference_services (
                service_id VARCHAR PRIMARY KEY,
                lineage_id VARCHAR NOT NULL,
                release_digest VARCHAR NOT NULL,
                release_id VARCHAR NOT NULL,
                label VARCHAR NOT NULL,
                timeline VARCHAR,
                request_count INTEGER NOT NULL
            )
            """
        )
        self._connection.execute(
            """
            CREATE TABLE IF NOT EXISTS cyclops_inference_service_members (
                service_id VARCHAR NOT NULL,
                root_digest VARCHAR NOT NULL,
                execution_digest VARCHAR NOT NULL,
                member_order INTEGER NOT NULL,
                PRIMARY KEY (service_id, execution_digest)
            )
            """
        )
        self._connection.execute(
            """
            CREATE TABLE IF NOT EXISTS cyclops_run_members (
                root_digest VARCHAR NOT NULL,
                execution_digest VARCHAR NOT NULL,
                record_id VARCHAR NOT NULL,
                label VARCHAR NOT NULL,
                depth INTEGER NOT NULL,
                status VARCHAR,
                diagnostic VARCHAR,
                member_order INTEGER NOT NULL,
                PRIMARY KEY (root_digest, execution_digest)
            )
            """
        )
        self._connection.execute(
            """
            CREATE TABLE IF NOT EXISTS cyclops_run_artifacts (
                root_digest VARCHAR NOT NULL,
                execution_digest VARCHAR NOT NULL,
                artifact_digest VARCHAR NOT NULL,
                direction VARCHAR NOT NULL,
                PRIMARY KEY (root_digest, execution_digest, artifact_digest, direction)
            )
            """
        )


def _decode_diagnostic(value: object) -> dict[str, object] | None:
    """Decode CYCLOPS's indexed diagnostic without trusting historical cache rows."""

    if not isinstance(value, str):
        return None
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError:
        return None
    return decoded if isinstance(decoded, dict) else None


def _lineage_label(runs: list[dict[str, object]]) -> str:
    """Give a connected lifecycle-run group a concise display name."""

    if not runs:
        return "Empty lineage"
    if len(runs) == 1:
        return str(runs[0]["label"])
    return "Connected lifecycle runs"


def _combined_status_counts(runs: list[dict[str, object]]) -> Counter[str]:
    """Add lifecycle-run status summaries without turning counts into fake events."""

    counts: Counter[str] = Counter()
    for run in runs:
        for status, count in run["status_counts"].items():
            counts[str(status)] += int(count)
    return counts
