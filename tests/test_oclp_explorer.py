"""Contract tests for the generic CYCLOPS OCLP graph projection and API."""

from __future__ import annotations

import hashlib
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

import duckdb
from fastapi.testclient import TestClient
from oclp import canonical_json_bytes, record_digest
from oclp.catalog.duckdb import DuckdbCatalog
from oclp.models import (
    Artifact,
    ArtifactSet,
    ArtifactSetMember,
    ComputationDefinition,
    Diagnostic,
    Digest,
    Evidence,
    Implementation,
    Invocation,
    LifecycleEvent,
    RecordReference,
)
from oclp.profiles import (
    DATASET_SNAPSHOT_PROFILE,
    DATASET_SNAPSHOT_PROFILE_VERSION,
    DatasetSnapshotBinding,
    DatasetSnapshotManifest,
    DatasetSnapshotPartition,
)

from oclp_explorer.app import create_app
from oclp_explorer.graph import _compact_label, load_project_graph
from oclp_explorer.run_index import CyclopsRunIndex


def test_project_graph_traverses_core_bindings_without_domain_imports(tmp_path: Path) -> None:
    root = tmp_path / "oclp"
    source = _publish(
        root,
        Artifact(
            id="urn:example:artifact:source",
            name="Source data",
            media_type="text/plain",
            digest=Digest(value="a" * 64),
            size=1,
        ),
    )
    definition = _publish(
        root,
        ComputationDefinition(
            id="urn:example:definition:transform",
            name="Transform",
            implementation=Implementation(
                kind="other",
                locator="example:transform",
                artifact=source,
                source={"kind": "opaque", "reason": "test fixture"},
            ),
        ),
    )
    output = _publish(
        root,
        Artifact(
            id="urn:example:artifact:output",
            name="Transformed output",
            media_type="text/plain",
            digest=Digest(value="b" * 64),
            size=1,
        ),
    )
    release = _publish(
        root,
        ArtifactSet(
            id="urn:example:artifact-set:release",
            name="Release",
            members=(ArtifactSetMember(name="result", artifact=output),),
        ),
    )
    invocation = _publish(
        root,
        Invocation(
            id="urn:example:invocation:transform",
            name="Transform input",
            definition=definition,
            inputs={"source": (source,)},
            outputs={"result": (output,), "release": (release,)},
        ),
    )
    _publish(
        root,
        LifecycleEvent(
            id="urn:example:event:outputs",
            name="Outputs published",
            invocation=invocation,
            event_type="outputs-published",
            occurred_at=datetime(2026, 8, 22, tzinfo=UTC),
            sequence=0,
            data={"outputs": {"result": output.model_dump(mode="json")}},
        ),
    )
    _publish(
        root,
        Evidence(
            id="urn:example:evidence:output",
            name="Output evidence",
            subject=invocation,
            contract={"id": "urn:example:contract:output", "version": "1"},
            outcome="pass",
            observed_at=datetime(2026, 8, 22, tzinfo=UTC),
        ),
    )
    input_bundle = _publish(
        root,
        ArtifactSet(
            id="urn:example:artifact-set:input-bundle",
            name="Input bundle from another run",
            members=(ArtifactSetMember(name="source", artifact=source),),
        ),
    )

    with DuckdbCatalog(tmp_path / "catalog.duckdb") as catalog:
        graph = load_project_graph(root, catalog=catalog)
        assert catalog.resolve(invocation).id == invocation.id

    invocation_node = next(node for node in graph.nodes if node["kind"] == "invocation")
    assert invocation_node["label"].splitlines()[:2] == [
        "invocation",
        "Transform input",
    ]
    assert all(node["label"].splitlines()[0] == node["kind"] for node in graph.nodes)

    assert graph.summary()["counts"] == {
        "artifact": 2,
        "artifact_set": 2,
        "definition": 1,
        "event": 1,
        "evidence": 1,
        "invocation": 1,
    }
    assert {edge["relation"] for edge in graph.reference_edges} == {
        "contains",
        "definition",
        "evidence-subject",
        "event-invocation",
        "event-reference",
        "implementation",
        "input",
        "output",
    }
    assert {edge["relation"] for edge in graph.derivation_edges} == {
        "consumes",
        "produces",
    }
    assert {edge["label"] for edge in graph.derivation_edges} == {
        "input: source",
        "output: result",
        "output: release",
    }
    assert {
        node["label"]
        for node in graph.nodes
        if node["id"] in {source.digest.value, output.digest.value}
    } == {"artifact\nSource data", "artifact\nTransformed output"}
    derivation = graph.graph_payload()
    assert {node["id"] for node in derivation["nodes"]} == {
        source.digest.value,
        invocation.digest.value,
        output.digest.value,
        release.digest.value,
    }
    assert input_bundle.digest.value not in {node["id"] for node in derivation["nodes"]}
    assert derivation["edges"] == list(graph.derivation_edges)
    assert derivation["collection_edges"][0]["label"] == "result"
    provenance = graph.graph_payload(view="provenance")
    provenance_nodes = {node["id"]: node for node in provenance["nodes"]}
    assert set(provenance_nodes) == {
        source.digest.value,
        definition.digest.value,
        invocation.digest.value,
        output.digest.value,
        release.digest.value,
        *[
            record_digest(record).value
            for record in graph.records.values()
            if record.kind in {"event", "evidence"}
        ],
    }
    assert provenance_nodes[source.digest.value]["layer"] == "data"
    assert provenance_nodes[definition.digest.value]["layer"] == "provenance"
    assert provenance_nodes[definition.digest.value]["label"] == "definition\nTransform"
    assert {edge["relation"] for edge in provenance["edges"]} == {
        "consumes",
        "definition",
        "evidence-subject",
        "event-invocation",
        "implementation",
        "produces",
    }
    assert not {edge["relation"] for edge in provenance["edges"]} & {
        "input",
        "output",
        "contains",
        "event-reference",
    }
    computations = graph.computations_payload()["computations"]
    assert len(computations) == 1
    assert computations[0]["invocation_count"] == 1
    assert computations[0]["label"] == "Transform input · 1 invocation"
    invocation_node = next(node for node in graph.nodes if node["id"] == invocation.digest.value)
    assert invocation_node["label"] == "invocation\nTransform input"
    focused = graph.focused_payload(invocation.digest.value, depth=1)
    assert invocation.digest.value in {node["id"] for node in focused["nodes"]}


def test_dataset_snapshot_input_groups_exact_partition_artifacts(tmp_path: Path) -> None:
    root = tmp_path / "oclp"
    first_part = _publish(
        root,
        Artifact(
            id="urn:example:artifact:dataset:part-00000",
            name="Part 00000",
            media_type="application/vnd.apache.parquet",
            digest=Digest(value="a" * 64),
            size=1,
        ),
    )
    second_part = _publish(
        root,
        Artifact(
            id="urn:example:artifact:dataset:part-00001",
            name="Part 00001",
            media_type="application/vnd.apache.parquet",
            digest=Digest(value="b" * 64),
            size=1,
        ),
    )
    manifest = DatasetSnapshotManifest(
        dataset_id="urn:example:dataset:lineup-stints:2025-26:regular",
        data_format="application/vnd.apache.parquet",
        partitions=(
            DatasetSnapshotPartition(name="part-00000.parquet", artifact=first_part),
            DatasetSnapshotPartition(name="part-00001.parquet", artifact=second_part),
        ),
    )
    content = canonical_json_bytes(manifest)
    payload_digest = Digest(value=hashlib.sha256(content).hexdigest())
    payload_path = (
        root
        / "payload"
        / payload_digest.value[:2]
        / (payload_digest.value + ".dataset-snapshot.json")
    )
    payload_path.parent.mkdir(parents=True, exist_ok=True)
    payload_path.write_bytes(content)
    snapshot = _publish(
        root,
        Artifact(
            id="urn:example:artifact:dataset-snapshot:lineup-stints:2025-26:regular",
            name="Lineup stints dataset snapshot - 2025-26 regular",
            media_type="application/vnd.oclp.dataset-snapshot-manifest+json",
            digest=payload_digest,
            size=len(content),
            locations=(payload_path.resolve().as_uri(),),
            schema_uri="urn:oclp:profile:dataset-snapshot:0.1.0-draft",
            profiles={
                DATASET_SNAPSHOT_PROFILE: DatasetSnapshotBinding(
                    version=DATASET_SNAPSHOT_PROFILE_VERSION,
                ).model_dump(mode="json")
            },
        ),
    )
    definition = _publish(
        root,
        ComputationDefinition(
            id="urn:example:definition:train",
            implementation=Implementation(
                kind="other",
                locator="example:train",
                source={"kind": "opaque", "reason": "test fixture"},
            ),
        ),
    )
    invocation = _publish(
        root,
        Invocation(
            id="urn:example:invocation:train",
            definition=definition,
            inputs={"lineup_stints_snapshot": (snapshot,)},
        ),
    )

    graph = load_project_graph(root)
    payload = graph.graph_payload(view="derivation", invocation=invocation.digest.value)

    nodes = {node["id"]: node for node in payload["nodes"]}
    assert nodes[snapshot.digest.value]["collection_kind"] == "dataset-snapshot"
    assert {first_part.digest.value, second_part.digest.value} <= set(nodes)
    assert {
        (edge["source"], edge["target"], edge["relation"]) for edge in payload["collection_edges"]
    } == {
        (snapshot.digest.value, first_part.digest.value, "dataset-partition"),
        (snapshot.digest.value, second_part.digest.value, "dataset-partition"),
    }


def test_provenance_view_connects_parent_and_child_invocations(tmp_path: Path) -> None:
    root = tmp_path / "oclp"
    definition = _publish(
        root,
        ComputationDefinition(
            id="urn:example:definition:flow",
            implementation=Implementation(
                kind="other",
                locator="example:flow",
                source={"kind": "opaque", "reason": "test fixture"},
            ),
        ),
    )
    parent = _publish(
        root,
        Invocation(
            id="urn:example:invocation:season-run",
            definition=definition,
            profiles={"lifecycle": {"version": "0.1.0-draft"}},
        ),
    )
    child = _publish(
        root,
        Invocation(
            id="urn:example:invocation:game-task",
            definition=definition,
            parent_invocation=RecordReference(id=parent.id),
            profiles={"lifecycle": {"version": "0.1.0-draft"}},
        ),
    )
    _publish(
        root,
        LifecycleEvent(
            id="urn:example:event:season-requested",
            invocation=parent,
            event_type="invocation-requested",
            occurred_at=datetime(2026, 8, 23, tzinfo=UTC),
            sequence=0,
            data={"run_id": "season-2026-08-23"},
        ),
    )
    _publish(
        root,
        LifecycleEvent(
            id="urn:example:event:game-requested",
            invocation=child,
            event_type="invocation-requested",
            occurred_at=datetime(2026, 8, 23, 0, 30, tzinfo=UTC),
            sequence=0,
        ),
    )
    _publish(
        root,
        LifecycleEvent(
            id="urn:example:event:game-started",
            invocation=child,
            event_type="attempt-started",
            occurred_at=datetime(2026, 8, 23, 0, 30, 1, tzinfo=UTC),
            sequence=1,
            attempt_id="game-attempt-1",
        ),
    )
    _publish(
        root,
        LifecycleEvent(
            id="urn:example:event:game-failed",
            invocation=child,
            event_type="invocation-terminal",
            occurred_at=datetime(2026, 8, 23, 1, tzinfo=UTC),
            sequence=2,
            status="failed",
            diagnostic=Diagnostic(
                code="process:preflight:ValueError",
                message="The terminal Event diagnostic, not Evidence details",
                stage="preflight",
            ),
        ),
    )
    _publish(
        root,
        Evidence(
            id="urn:example:evidence:game-failed",
            subject=child,
            contract={"id": "urn:example:contract:game-quality", "version": "1"},
            outcome="error",
            observed_at=datetime(2026, 8, 23, 1, tzinfo=UTC),
            details={"error_message": "Application-specific Evidence detail"},
        ),
    )

    graph = load_project_graph(root)
    runs = graph.runs_payload()["runs"]
    assert runs == [
        {
            "id": parent.digest.value,
            "record_id": parent.id,
            "label": "example:flow · season-2026-08-23",
            "timeline": {
                "kind": "lifecycle",
                "requested_at": "2026-08-23T00:00:00+00:00",
                "started_at": None,
                "completed_at": None,
                "first_event_at": "2026-08-23T00:00:00+00:00",
                "last_event_at": "2026-08-23T00:00:00+00:00",
            },
            "invocation_count": 2,
            "artifact_count": 0,
            "status_counts": {"failed": 1},
            "invocations": [
                {
                    "id": parent.digest.value,
                    "record_id": parent.id,
                    "label": "example:flow",
                    "depth": 0,
                    "status": "incomplete",
                    "diagnostic": None,
                },
                {
                    "id": child.digest.value,
                    "record_id": child.id,
                    "label": "example:flow",
                    "depth": 1,
                    "status": "failed",
                    "diagnostic": {
                        "code": "process:preflight:ValueError",
                        "message": "The terminal Event diagnostic, not Evidence details",
                        "stage": "preflight",
                    },
                },
            ],
        }
    ]
    with CyclopsRunIndex(tmp_path / "cyclops.duckdb") as run_index:
        run_index.rebuild(graph)
        assert run_index.runs_payload()["runs"] == runs
        assert run_index.summary() == {
            "run_count": 1,
            "run_member_count": 2,
            "run_artifact_count": 0,
        }
    with TestClient(create_app(root)) as client:
        assert client.get("/api/runs").json()["runs"] == runs
        assert client.get("/api/health").json()["run_index"] == {
            "run_count": 1,
            "run_member_count": 2,
            "run_artifact_count": 0,
        }
    run_graph = graph.graph_payload(view="run", run=parent.digest.value)
    assert {node["id"] for node in run_graph["nodes"]} == {
        parent.digest.value,
        child.digest.value,
    }
    assert {(edge["source"], edge["target"], edge["relation"]) for edge in run_graph["edges"]} == {
        (parent.digest.value, child.digest.value, "orchestrates")
    }
    child_data = graph.graph_payload(
        view="derivation",
        run=parent.digest.value,
        invocation=child.digest.value,
    )
    assert {node["id"] for node in child_data["nodes"]} == {child.digest.value}
    child_provenance = graph.graph_payload(
        view="provenance",
        run=parent.digest.value,
        invocation=child.digest.value,
    )
    assert parent.digest.value not in {node["id"] for node in child_provenance["nodes"]}
    parent_component = next(
        component_id
        for component_id, node_ids in graph._components().items()
        if parent.digest.value in node_ids
    )
    provenance = graph.graph_payload(view="provenance", component=parent_component)

    assert {node["id"] for node in provenance["nodes"]} >= {
        parent.digest.value,
        child.digest.value,
    }
    assert {(edge["source"], edge["target"], edge["relation"]) for edge in provenance["edges"]} >= {
        (parent.digest.value, child.digest.value, "orchestrates")
    }


def test_graph_reads_legacy_empty_profile_records_without_rewriting_identity(
    tmp_path: Path,
) -> None:
    root = tmp_path / "oclp"
    current = Artifact(
        id="urn:example:artifact:legacy-empty-profiles",
        media_type="text/plain",
        digest=Digest(value="a" * 64),
        size=1,
    )
    fields = current.__dict__.copy()
    fields["profiles"] = {}
    legacy = Artifact.model_construct(**fields)
    digest = record_digest(legacy)
    path = root / "artifact" / digest.value[:2] / f"{digest.value}.json"
    path.parent.mkdir(parents=True)
    path.write_bytes(canonical_json_bytes(legacy) + b"\n")

    graph = load_project_graph(root)
    assert set(graph.records) == {digest.value}
    assert graph.nodes[0]["record_id"] == current.id

    with DuckdbCatalog(tmp_path / "catalog.duckdb") as catalog:
        catalog_graph = load_project_graph(root, catalog=catalog)
    assert set(catalog_graph.records) == {digest.value}


def test_graph_compacts_long_artifact_resource_labels_to_a_short_identifier() -> None:
    assert _compact_label("9a/9a123ca8bb6b72f52cf5e05ae6cb1ebdb.source-bundle") == "9a123ca8"


def test_cyclops_run_index_migrates_existing_navigation_database(tmp_path: Path) -> None:
    database = tmp_path / "cyclops.duckdb"
    connection = duckdb.connect(str(database))
    connection.execute(
        """
        CREATE TABLE cyclops_run_members (
            root_digest VARCHAR NOT NULL,
            invocation_digest VARCHAR NOT NULL,
            record_id VARCHAR NOT NULL,
            label VARCHAR NOT NULL,
            depth INTEGER NOT NULL,
            PRIMARY KEY (root_digest, invocation_digest)
        )
        """
    )
    connection.close()

    with CyclopsRunIndex(database) as run_index:
        columns = {
            row[1]
            for row in run_index._connection.execute(
                "PRAGMA table_info('cyclops_run_members')"
            ).fetchall()
        }

    assert {"status", "diagnostic"} <= columns


def test_cyclops_api_exposes_graph_record_and_focused_lineage(tmp_path: Path) -> None:
    root = tmp_path / "oclp"
    artifact = _publish(
        root,
        Artifact(
            id="urn:example:artifact",
            media_type="application/octet-stream",
            digest=Digest(value="c" * 64),
            size=1,
        ),
    )
    client = TestClient(create_app(root))

    assert client.get("/api/health").json()["record_count"] == 1
    assert client.get("/api/computations").json()["computations"] == []
    assert client.get("/api/runs").json()["runs"] == []
    assert client.get("/api/graph").json()["view"] == "derivation"
    assert client.get("/api/graph?view=provenance").json()["view"] == "provenance"
    assert client.get(f"/api/records/{artifact.digest.value}").json()["record"]["id"] == artifact.id
    assert client.get(f"/api/lineage/{artifact.digest.value}").status_code == 200
    assert client.get("/api/records/not-a-digest").status_code == 404

    later_artifact = _publish(
        root,
        Artifact(
            id="urn:example:artifact:later",
            media_type="application/octet-stream",
            digest=Digest(value="e" * 64),
            size=1,
        ),
    )
    assert client.get("/api/health").json()["record_count"] == 1
    assert client.get(f"/api/records/{later_artifact.digest.value}").status_code == 404
    assert client.get("/api/health?refresh=true").json()["record_count"] == 2
    assert (
        client.get(f"/api/records/{later_artifact.digest.value}").json()["record"]["id"]
        == later_artifact.id
    )


def test_cyclops_api_serializes_concurrent_catalog_loads(tmp_path: Path) -> None:
    root = tmp_path / "oclp"
    _publish(
        root,
        Artifact(
            id="urn:example:artifact",
            media_type="application/octet-stream",
            digest=Digest(value="d" * 64),
            size=1,
        ),
    )
    client = TestClient(create_app(root))

    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(client.get, ("/api/health", "/api/graph?view=provenance")))

    assert [response.status_code for response in responses] == [200, 200]


def test_cyclops_api_caches_a_snapshot_until_manual_refresh(tmp_path: Path) -> None:
    root = tmp_path / "oclp"
    _publish(
        root,
        Artifact(
            id="urn:example:artifact",
            media_type="application/octet-stream",
            digest=Digest(value="f" * 64),
            size=1,
        ),
    )

    with patch(
        "oclp_explorer.app.load_project_graph",
        wraps=load_project_graph,
    ) as load_graph:
        with TestClient(create_app(root)) as client:
            assert client.get("/api/health").status_code == 200
            assert client.get("/api/runs").status_code == 200
            assert client.get("/api/graph?view=provenance").status_code == 200
            assert load_graph.call_count == 1

            assert client.get("/api/health?refresh=true").status_code == 200
            assert load_graph.call_count == 2


def _publish(root: Path, record: object) -> RecordReference:
    digest = record_digest(record)
    path = root / record.kind / digest.value[:2] / f"{digest.value}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(canonical_json_bytes(record) + b"\n")
    return RecordReference(id=record.id, digest=digest)
