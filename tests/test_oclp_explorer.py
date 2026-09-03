"""Tests for CYCLOPS's Computation/Execution projections."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

from fastapi.testclient import TestClient
from oclp import ArtifactSet, ArtifactSetMember, Event, Evidence, Execution, evidence
from oclp.computations import computation, computation_record
from oclp.models import GitSource, Implementation, RecordReference
from oclp.publishing import LocalArtifactPublisher

from oclp_explorer.app import create_app
from oclp_explorer.graph import load_project_graph
from oclp_explorer.run_index import CyclopsRunIndex


@computation(id="urn:example:computation:prepare", name="Prepare features")
def _prepare() -> None: ...


@evidence(name="Release check")
def _release_check(model: object) -> str:
    return "pass"


@computation(
    id="urn:example:computation:train",
    name="Train model",
    requires=(_release_check,),
)
def _train() -> None: ...


def _publisher(root: Path) -> LocalArtifactPublisher:
    return LocalArtifactPublisher(
        catalog_path=root / "catalog.duckdb",
        record_root=root,
        payload_root=root / "payload",
    )


def _fixture_store(root: Path) -> dict[str, RecordReference]:
    """Publish a parent/child execution tree with direct data handoffs."""

    now = datetime(2026, 8, 30, 12, 0, tzinfo=UTC)
    with _publisher(root) as publisher:
        source = publisher.json_artifact(
            artifact_id="urn:example:artifact:source",
            name="Source data",
            relative_path="source.json",
            value={"rows": 12},
            created_at=now,
        ).reference
        features = publisher.json_artifact(
            artifact_id="urn:example:artifact:features",
            name="Feature table",
            relative_path="features.json",
            value={"rows": 10},
            created_at=now + timedelta(seconds=10),
        ).reference
        model = publisher.json_artifact(
            artifact_id="urn:example:artifact:model",
            name="Model package",
            relative_path="model.json",
            value={"model": "linear"},
            created_at=now + timedelta(seconds=20),
        ).reference
        release = publisher.publish(
            ArtifactSet(
                id="urn:example:artifact-set:model-release",
                name="Candidate release",
                created_at=now + timedelta(seconds=21),
                members=(ArtifactSetMember(name="model", artifact=model),),
            )
        )
        source_basis = GitSource(repository="https://example.test/project.git", commit="a" * 40)
        prepare = publisher.publish(computation_record(_prepare, source=source_basis))
        train = publisher.publish(computation_record(_train, source=source_basis))
        root_execution = publisher.publish(
            Execution(
                id="urn:example:execution:prepare:one",
                name="Prepare features for August",
                profiles={"lifecycle": {"version": "0.2.0-draft"}},
                computation=prepare,
                inputs={"source": (source,)},
                outputs={"features": (features,)},
            )
        )
        child_execution = publisher.publish(
            Execution(
                id="urn:example:execution:train:one",
                name="Train August candidate",
                profiles={"lifecycle": {"version": "0.2.0-draft"}},
                computation=train,
                parent_execution=root_execution,
                inputs={"features": (features,)},
                outputs={"model": (model,), "release": (release,)},
            )
        )
        for execution, offset in ((root_execution, 0), (child_execution, 10)):
            started_at = now + timedelta(seconds=offset)
            publisher.publish(
                Event(
                    id=f"urn:example:event:{execution.id.rsplit(':', 1)[-1]}:started",
                    execution=execution,
                    event_type="execution-started",
                    occurred_at=started_at,
                    sequence=0,
                )
            )
            publisher.publish(
                Event(
                    id=f"urn:example:event:{execution.id.rsplit(':', 1)[-1]}:terminal",
                    execution=execution,
                    event_type="execution-terminal",
                    occurred_at=started_at + timedelta(seconds=1),
                    sequence=1,
                    status="succeeded",
                )
            )
        evidence = publisher.publish(
            Evidence(
                id="urn:example:evidence:release-check",
                name="Release check",
                subject=child_execution,
                evaluator=Implementation(
                    kind="python-callable",
                    locator=f"{__name__}._release_check",
                    source=source_basis,
                ),
                outcome="pass",
                observed_at=now + timedelta(seconds=22),
            )
        )
    return {
        "source": source,
        "features": features,
        "model": model,
        "release": release,
        "root_execution": root_execution,
        "child_execution": child_execution,
        "evidence": evidence,
    }


def test_data_dag_is_artifact_execution_artifact_and_uses_new_kinds(tmp_path: Path) -> None:
    root = tmp_path / "oclp"
    refs = _fixture_store(root)
    graph = load_project_graph(root)

    nodes = {node["id"]: node for node in graph.nodes}
    assert {node["kind"] for node in nodes.values()} == {
        "artifact",
        "artifact_set",
        "computation",
        "execution",
        "evidence",
        "event",
    }
    execution = refs["child_execution"].digest.value
    features = refs["features"].digest.value
    model = refs["model"].digest.value
    dag = graph.graph_payload(view="derivation", execution=execution)
    edges = {(edge["source"], edge["target"], edge["relation"]) for edge in dag["edges"]}
    assert (features, execution, "consumes") in edges
    assert (execution, model, "produces") in edges
    assert nodes[features]["media_type"] == "application/json"
    assert nodes[features]["label"].split("\n", maxsplit=1)[0] == "application/json"
    assert nodes[refs["evidence"].digest.value]["outcome"] == "pass"
    assert {
        nodes[refs["root_execution"].digest.value]["status"],
        nodes[refs["child_execution"].digest.value]["status"],
    } == {"succeeded"}
    assert {
        node["status"]
        for node in nodes.values()
        if node["kind"] == "event" and "status" in node
    } == {"succeeded"}
    started_event = next(
        node
        for node in nodes.values()
        if node["kind"] == "event" and node["label"] == "event\nexecution-started"
    )
    assert started_event["record_id"].startswith("urn:example:event:")
    assert graph.summary()["incomplete_execution_count"] == 0


def test_terminal_execution_status_does_not_require_a_lifecycle_profile(
    tmp_path: Path,
) -> None:
    """A request-scoped Execution is complete when its terminal Event is present."""

    root = tmp_path / "oclp"
    now = datetime(2026, 9, 2, 20, 30, tzinfo=UTC)
    with _publisher(root) as publisher:
        computation = publisher.publish(
            computation_record(
                _prepare,
                source=GitSource(
                    repository="https://example.test/project.git",
                    commit="c" * 40,
                ),
            )
        )
        execution = publisher.publish(
            Execution(
                id="urn:example:execution:request-scoped-prediction",
                name="Request-scoped prediction",
                computation=computation,
            )
        )
        publisher.publish(
            Event(
                id="urn:example:event:request-scoped-prediction:started",
                execution=execution,
                event_type="execution-started",
                occurred_at=now,
                sequence=0,
            )
        )
        publisher.publish(
            Event(
                id="urn:example:event:request-scoped-prediction:terminal",
                execution=execution,
                event_type="execution-terminal",
                occurred_at=now + timedelta(seconds=1),
                sequence=1,
                status="succeeded",
            )
        )

    graph = load_project_graph(root)
    node = next(node for node in graph.nodes if node["id"] == execution.digest.value)
    assert node["status"] == "succeeded"
    assert graph.summary()["incomplete_execution_count"] == 0


def test_release_backed_request_executions_project_as_one_inference_service(
    tmp_path: Path,
) -> None:
    """CYCLOPS may collapse real serving requests without changing OCLP facts."""

    root = tmp_path / "oclp"
    refs = _fixture_store(root)
    now = datetime(2026, 9, 2, 12, 0, tzinfo=UTC)
    with _publisher(root) as publisher:
        request_one = publisher.json_artifact(
            artifact_id="urn:example:artifact:inference-request:one",
            name="Prediction request one",
            relative_path="request-one.json",
            value={"hour": 9},
            created_at=now,
        ).reference
        request_two = publisher.json_artifact(
            artifact_id="urn:example:artifact:inference-request:two",
            name="Prediction request two",
            relative_path="request-two.json",
            value={"hour": 10},
            created_at=now + timedelta(seconds=1),
        ).reference
        response_one = publisher.json_artifact(
            artifact_id="urn:example:artifact:inference-response:one",
            name="Prediction response one",
            relative_path="response-one.json",
            value={"prediction": 12.5},
            created_at=now + timedelta(seconds=2),
        ).reference
        response_two = publisher.json_artifact(
            artifact_id="urn:example:artifact:inference-response:two",
            name="Prediction response two",
            relative_path="response-two.json",
            value={"prediction": 13.5},
            created_at=now + timedelta(seconds=3),
        ).reference
        prediction = publisher.publish(
            computation_record(
                _prepare,
                source=GitSource(
                    repository="https://example.test/project.git",
                    commit="d" * 40,
                ),
            )
        )
        executions = (
            publisher.publish(
                Execution(
                    id="urn:example:execution:predict:one",
                    name="Predict request one",
                    computation=prediction,
                    inputs={
                        "model_release": (refs["release"],),
                        "request": (request_one,),
                    },
                    outputs={"response": (response_one,)},
                )
            ),
            publisher.publish(
                Execution(
                    id="urn:example:execution:predict:two",
                    name="Predict request two",
                    computation=prediction,
                    inputs={
                        "model_release": (refs["release"],),
                        "request": (request_two,),
                    },
                    outputs={"response": (response_two,)},
                )
            ),
        )
        for offset, execution in enumerate(executions):
            publisher.publish(
                Event(
                    id=f"urn:example:event:prediction:{offset}:started",
                    execution=execution,
                    event_type="execution-started",
                    occurred_at=now + timedelta(seconds=offset),
                    sequence=0,
                )
            )
            publisher.publish(
                Event(
                    id=f"urn:example:event:prediction:{offset}:terminal",
                    execution=execution,
                    event_type="execution-terminal",
                    occurred_at=now + timedelta(seconds=offset + 1),
                    sequence=1,
                    status="succeeded",
                )
            )

    graph = load_project_graph(root)
    services = graph.inference_services_payload()
    assert len(services) == 1
    service = services[0]
    assert service["release_id"] == refs["release"].id
    assert service["request_count"] == 2
    assert service["status_counts"] == {"succeeded": 2}
    assert refs["model"].digest.value not in service["hidden_node_ids"]
    assert executions[0].digest.value in service["hidden_node_ids"]
    assert response_one.digest.value in service["hidden_node_ids"]

    # A Run is only its own lifecycle. The service is a sibling process in
    # the wider release lineage, so it appears only when the caller selects
    # that explicit scope.
    run_payload = graph.graph_payload(view="run", run=refs["root_execution"].digest.value)
    assert run_payload["inference_services"] == []
    lineage_payload = graph.graph_payload(
        view="run",
        run=refs["root_execution"].digest.value,
        lineage=True,
    )
    visible_service = lineage_payload["inference_services"][0]
    assert visible_service["source_node_id"] in {
        refs["release"].digest.value,
        refs["model"].digest.value,
    }
    # The navigator keeps serving beside training in one lineage, but opening
    # that service must not append its request materializations to the whole
    # training graph. Its focused graph keeps only the release handoff plus
    # the real request Executions and their direct records.
    assert lineage_payload["lifecycle_groups"][0]["title"] == "Lineage"
    focused_service = graph.graph_payload(view="run", service=service["id"])
    focused_node_ids = {node["id"] for node in focused_service["nodes"]}
    assert set(execution.digest.value for execution in executions) <= focused_node_ids
    assert refs["root_execution"].digest.value not in focused_node_ids
    assert refs["release"].digest.value in focused_node_ids
    assert focused_service["lifecycle_groups"] == [
        {
            "id": f"inference-service:{service['id']}",
            "root_id": service["id"],
            "title": "Inference service",
            "label": service["label"],
            "member_ids": sorted(focused_node_ids),
        }
    ]

    with CyclopsRunIndex(root / "cyclops.duckdb") as index:
        index.rebuild(graph)
        lineages = index.runs_payload()["lineages"]
    lineage = next(lineage for lineage in lineages if lineage["inference_services"])
    assert len(lineage["inference_services"]) == 1
    assert len(lineage["inference_services"][0]["requests"]) == 2
    # Raw runs remain in the API for direct consumers, but the explorer tree
    # shows the release run plus one service child rather than two fake runs.
    request_execution_ids = {execution.digest.value for execution in executions}
    assert all(run["id"] not in request_execution_ids for run in lineage["runs"])


def test_run_projection_exposes_execution_hierarchy_in_chronological_order(tmp_path: Path) -> None:
    root = tmp_path / "oclp"
    refs = _fixture_store(root)
    graph = load_project_graph(root)

    run = graph.runs_payload()["runs"][0]
    assert run["execution_count"] == 2
    assert [member["id"] for member in run["executions"]] == [
        refs["root_execution"].digest.value,
        refs["child_execution"].digest.value,
    ]
    assert run["timeline"]["started_at"] == "2026-08-30T12:00:00+00:00"
    assert run["status_counts"] == {"succeeded": 1}

    payload = graph.graph_payload(view="run", run=refs["root_execution"].digest.value)
    # parent_execution is presented as a lifecycle boundary, not as a second
    # kind of causal dataflow edge. The boundary contains the entire run
    # materialization, including its data and Computation records.
    assert all(edge["relation"] != "orchestrates" for edge in payload["edges"])
    group = payload["lifecycle_groups"][0]
    assert group["id"] == f"lifecycle:{refs['root_execution'].digest.value}"
    assert group["root_id"] == refs["root_execution"].digest.value
    assert group["label"] == "Prepare features for August"
    assert {
        refs["source"].digest.value,
        refs["features"].digest.value,
        refs["model"].digest.value,
        refs["release"].digest.value,
        refs["root_execution"].digest.value,
        refs["child_execution"].digest.value,
    } <= set(group["member_ids"])
    assert set(group["member_ids"]) == {node["id"] for node in payload["nodes"]}
    assert any(node["kind"] == "computation" for node in payload["nodes"])


def test_lifecycle_profile_groups_real_executions_without_a_controller(tmp_path: Path) -> None:
    """A profile run is a grouping claim, never a synthetic Execution."""

    root = tmp_path / "oclp"
    now = datetime(2026, 9, 1, 12, 0, tzinfo=UTC)
    run_id = "urn:example:lifecycle:nightly-build"
    with _publisher(root) as publisher:
        source = publisher.json_artifact(
            artifact_id="urn:example:artifact:profile-source",
            name="Profile source",
            relative_path="source.json",
            value={"rows": 12},
            created_at=now,
        ).reference
        features = publisher.json_artifact(
            artifact_id="urn:example:artifact:profile-features",
            name="Profile features",
            relative_path="features.json",
            value={"rows": 10},
            created_at=now + timedelta(seconds=1),
        ).reference
        source_basis = GitSource(
            repository="https://example.test/project.git",
            commit="b" * 40,
        )
        prepare = publisher.publish(computation_record(_prepare, source=source_basis))
        train = publisher.publish(computation_record(_train, source=source_basis))
        profile = {
            "lifecycle": {
                "version": "0.2.0-draft",
                "run_id": run_id,
                "run_name": "Nightly build",
            }
        }
        release = publisher.publish(
            ArtifactSet(
                id="urn:example:artifact-set:profile-release",
                name="Profile release",
                profiles=profile,
                created_at=now + timedelta(seconds=2),
                members=(
                    ArtifactSetMember(name="features", artifact=features),
                ),
            )
        )
        prepare_execution = publisher.publish(
            Execution(
                id="urn:example:execution:profile-prepare",
                name="Profile prepare",
                profiles=profile,
                computation=prepare,
                inputs={"source": (source,)},
                outputs={"features": (features,)},
            )
        )
        train_execution = publisher.publish(
            Execution(
                id="urn:example:execution:profile-train",
                name="Profile train",
                profiles=profile,
                computation=train,
                inputs={"features": (features,)},
            )
        )
        for execution, offset in ((prepare_execution, 0), (train_execution, 1)):
            publisher.publish(
                Event(
                    id=f"urn:example:event:{execution.id.rsplit(':', 1)[-1]}:started",
                    execution=execution,
                    event_type="execution-started",
                    occurred_at=now + timedelta(seconds=offset),
                    sequence=0,
                )
            )
            publisher.publish(
                Event(
                    id=f"urn:example:event:{execution.id.rsplit(':', 1)[-1]}:terminal",
                    execution=execution,
                    event_type="execution-terminal",
                    occurred_at=now + timedelta(seconds=offset + 1),
                    sequence=1,
                    status="succeeded",
                )
            )

    graph = load_project_graph(root)
    run = graph.runs_payload()["runs"][0]
    assert run["id"] == run_id
    assert run["label"] == "Nightly build"
    assert run["execution_count"] == 2
    assert run["status_counts"] == {"succeeded": 2}
    assert {member["depth"] for member in run["executions"]} == {0}
    payload = graph.graph_payload(view="run", run=run_id)
    assert {
        node["id"] for node in payload["nodes"] if node["kind"] == "execution"
    } == {
        prepare_execution.digest.value,
        train_execution.digest.value,
    }
    assert release.digest.value in {node["id"] for node in payload["nodes"]}
    assert all(edge["relation"] != "orchestrates" for edge in payload["edges"])
    assert len(payload["lifecycle_groups"]) == 1
    group = payload["lifecycle_groups"][0]
    assert group["id"] == f"lifecycle:{run_id}"
    assert group["root_id"] == prepare_execution.digest.value
    assert group["label"] == "Nightly build"
    assert {
        prepare_execution.digest.value,
        train_execution.digest.value,
        source.digest.value,
        features.digest.value,
        release.digest.value,
    } <= set(group["member_ids"])
    timeline = graph.graph_payload(view="timeline", run=run_id)
    timeline_release = next(
        node for node in timeline["nodes"] if node["id"] == release.digest.value
    )
    assert timeline_release["timeline_role"] == "publication"
    assert timeline_release["timeline_at"] == "2026-09-01T12:00:02+00:00"
    focused = graph.graph_payload(
        view="derivation",
        run=run_id,
        execution=prepare_execution.digest.value,
    )
    assert release.digest.value not in {node["id"] for node in focused["nodes"]}


def test_provenance_and_timeline_bind_events_to_their_execution(tmp_path: Path) -> None:
    root = tmp_path / "oclp"
    refs = _fixture_store(root)
    graph = load_project_graph(root)

    execution = refs["child_execution"].digest.value
    provenance = graph.graph_payload(view="provenance", execution=execution)
    assert any(edge["relation"] == "event-execution" for edge in provenance["edges"])
    assert any(edge["relation"] == "evidence-subject" for edge in provenance["edges"])
    assert any(node["kind"] == "evidence" for node in provenance["nodes"])
    assert any(node["kind"] == "computation" for node in provenance["nodes"])
    timeline = graph.graph_payload(
        view="timeline",
        run=refs["root_execution"].digest.value,
        execution=execution,
    )
    model = next(node for node in timeline["nodes"] if node["id"] == refs["model"].digest.value)
    assert model["timeline_role"] == "output"
    assert model["timeline_at"] == "2026-08-30T12:00:20+00:00"
    assert refs["root_execution"].digest.value not in {node["id"] for node in timeline["nodes"]}


def test_collection_overlay_keeps_the_artifact_set_and_member_explicit(tmp_path: Path) -> None:
    root = tmp_path / "oclp"
    refs = _fixture_store(root)
    graph = load_project_graph(root)

    payload = graph.graph_payload(view="derivation", execution=refs["child_execution"].digest.value)
    assert any(
        edge["source"] == refs["release"].digest.value
        and edge["target"] == refs["model"].digest.value
        and edge["relation"] == "contains"
        for edge in payload["collection_edges"]
    )


def test_run_index_and_api_use_execution_names(tmp_path: Path) -> None:
    root = tmp_path / "oclp"
    refs = _fixture_store(root)
    graph = load_project_graph(root)
    with CyclopsRunIndex(root / "cyclops.duckdb") as index:
        index.rebuild(graph)
        indexed = index.runs_payload()
    assert "executions" in indexed["runs"][0]
    assert "invocations" not in indexed["runs"][0]

    with TestClient(create_app(root)) as client:
        runs = client.get("/api/runs")
        assert runs.status_code == 200
        assert runs.json()["runs"][0]["execution_count"] == 2
        response = client.get(
            "/api/graph",
            params={"view": "timeline", "execution": refs["child_execution"].digest.value},
        )
        assert response.status_code == 200
        assert any(node["kind"] == "execution" for node in response.json()["nodes"])
