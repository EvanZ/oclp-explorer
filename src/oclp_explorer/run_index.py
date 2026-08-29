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
        """Replace the index with the current root-run and lineage hierarchy."""

        runs = graph.runs_payload()["runs"]
        run_rows: list[tuple[object, ...]] = []
        member_rows: list[tuple[object, ...]] = []
        artifact_rows: list[tuple[object, ...]] = []

        for sort_order, run in enumerate(runs):
            root_digest = str(run["id"])
            # A lineage can have several explicit orchestration roots when an
            # Artifact handoff links independently started runs.  The stable
            # lexical root digest is an implementation-only group key;
            # the actual root Invocation IDs remain the public identities.
            lineage_id = min(graph.run_lineage_roots(root_digest))
            run_rows.append(
                (
                    root_digest,
                    lineage_id,
                    str(run["record_id"]),
                    str(run["label"]),
                    json.dumps(run["timeline"]),
                    int(run["invocation_count"]),
                    int(run["artifact_count"]),
                    sort_order,
                )
            )
            invocation_digests = {
                str(invocation["id"])
                for invocation in run["invocations"]  # type: ignore[index]
            }
            for invocation in run["invocations"]:  # type: ignore[index]
                member_rows.append(
                    (
                        root_digest,
                        str(invocation["id"]),
                        str(invocation["record_id"]),
                        str(invocation["label"]),
                        int(invocation["depth"]),
                        str(invocation["status"]),
                        json.dumps(invocation["diagnostic"])
                        if invocation["diagnostic"] is not None
                        else None,
                    )
                )
            run_graph = graph.graph_payload(view="run", run=root_digest)
            for edge in run_graph["edges"]:  # type: ignore[index]
                if edge["relation"] == "consumes" and edge["target"] in invocation_digests:
                    invocation_digest, artifact_digest, direction = (
                        edge["target"],
                        edge["source"],
                        "input",
                    )
                elif edge["relation"] == "produces" and edge["source"] in invocation_digests:
                    invocation_digest, artifact_digest, direction = (
                        edge["source"],
                        edge["target"],
                        "output",
                    )
                else:
                    continue
                if graph.records[artifact_digest].kind == "artifact":
                    artifact_rows.append(
                        (root_digest, invocation_digest, artifact_digest, direction)
                    )

        self._connection.execute("BEGIN TRANSACTION")
        try:
            self._connection.execute("DELETE FROM cyclops_run_artifacts")
            self._connection.execute("DELETE FROM cyclops_run_members")
            self._connection.execute("DELETE FROM cyclops_runs")
            if run_rows:
                self._connection.executemany(
                    """
                    INSERT INTO cyclops_runs
                        (root_digest, lineage_id, record_id, label, timeline, invocation_count,
                         artifact_count, sort_order)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    run_rows,
                )
            if member_rows:
                self._connection.executemany(
                    """
                    INSERT INTO cyclops_run_members
                        (root_digest, invocation_digest, record_id, label, depth,
                         status, diagnostic)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    member_rows,
                )
            if artifact_rows:
                self._connection.executemany(
                    """
                    INSERT INTO cyclops_run_artifacts
                        (root_digest, invocation_digest, artifact_digest, direction)
                    VALUES (?, ?, ?, ?)
                    """,
                    artifact_rows,
                )
        except Exception:
            self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")

    def runs_payload(self) -> dict[str, object]:
        """Return the API tree model straight from the persistent read model.

        ``runs`` remains available for small consumers, while ``lineages`` is
        the navigation projection: a connected group of one or more root runs
        joined by explicit produced-and-consumed Artifact handoffs.
        """

        members_by_run: dict[str, list[dict[str, object]]] = {}
        for row in self._connection.execute(
            """
            SELECT root_digest, invocation_digest, record_id, label, depth,
                   status, diagnostic
            FROM cyclops_run_members
            ORDER BY root_digest, depth, label, record_id
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
                   timeline, invocation_count, artifact_count
            FROM cyclops_runs
            ORDER BY sort_order
            """
        ).fetchall():
            members = members_by_run.get(row[0], [])
            status_members = [member for member in members if member["depth"] > 0]
            if not status_members:
                status_members = members
            run = {
                "id": row[0],
                "record_id": row[2],
                "label": row[3],
                "timeline": json.loads(row[4]),
                "invocation_count": row[5],
                "artifact_count": row[6],
                "status_counts": dict(
                    sorted(
                        Counter(str(member["status"]) for member in status_members).items()
                    )
                ),
                "invocations": members,
            }
            runs.append(run)
            lineages_by_id.setdefault(str(row[1]), []).append(run)

        lineages = [
            {
                "id": lineage_id,
                "label": _lineage_label(lineage_runs),
                "root_count": len(lineage_runs),
                "invocation_count": sum(
                    int(run["invocation_count"]) for run in lineage_runs
                ),
                "artifact_count": sum(int(run["artifact_count"]) for run in lineage_runs),
                "status_counts": dict(
                    sorted(
                        _combined_status_counts(lineage_runs).items()
                    )
                ),
                "runs": lineage_runs,
            }
            for lineage_id, lineage_runs in lineages_by_id.items()
        ]
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
        self._connection.execute(
            """
            CREATE TABLE IF NOT EXISTS cyclops_runs (
                root_digest VARCHAR PRIMARY KEY,
                lineage_id VARCHAR,
                record_id VARCHAR NOT NULL,
                label VARCHAR NOT NULL,
                timeline VARCHAR,
                invocation_count INTEGER NOT NULL,
                artifact_count INTEGER NOT NULL,
                sort_order INTEGER NOT NULL
            )
            """
        )
        self._connection.execute(
            "ALTER TABLE cyclops_runs ADD COLUMN IF NOT EXISTS timeline VARCHAR"
        )
        self._connection.execute(
            "ALTER TABLE cyclops_runs ADD COLUMN IF NOT EXISTS lineage_id VARCHAR"
        )
        self._connection.execute(
            """
            CREATE TABLE IF NOT EXISTS cyclops_run_members (
                root_digest VARCHAR NOT NULL,
                invocation_digest VARCHAR NOT NULL,
                record_id VARCHAR NOT NULL,
                label VARCHAR NOT NULL,
                depth INTEGER NOT NULL,
                status VARCHAR,
                diagnostic VARCHAR,
                PRIMARY KEY (root_digest, invocation_digest)
            )
            """
        )
        self._connection.execute(
            "ALTER TABLE cyclops_run_members ADD COLUMN IF NOT EXISTS status VARCHAR"
        )
        self._connection.execute(
            "ALTER TABLE cyclops_run_members ADD COLUMN IF NOT EXISTS diagnostic VARCHAR"
        )
        self._connection.execute(
            """
            CREATE TABLE IF NOT EXISTS cyclops_run_artifacts (
                root_digest VARCHAR NOT NULL,
                invocation_digest VARCHAR NOT NULL,
                artifact_digest VARCHAR NOT NULL,
                direction VARCHAR NOT NULL,
                PRIMARY KEY (root_digest, invocation_digest, artifact_digest, direction)
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
    """Give a connected root-run group a concise, non-invented display name."""

    if not runs:
        return "Empty lineage"
    if len(runs) == 1:
        return str(runs[0]["label"])
    return "Connected root runs"


def _combined_status_counts(runs: list[dict[str, object]]) -> Counter[str]:
    """Add root-run status summaries without turning counts into fake events."""

    counts: Counter[str] = Counter()
    for run in runs:
        for status, count in run["status_counts"].items():
            counts[str(status)] += int(count)
    return counts
