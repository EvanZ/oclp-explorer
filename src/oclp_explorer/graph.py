"""Project-level OCLP graph projection with no domain-model dependency."""

from __future__ import annotations

import hashlib
import json
from collections import Counter, deque
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal
from urllib.parse import unquote, urlparse

from oclp import (
    parse_record,
)
from oclp.catalog.duckdb import DuckdbCatalog
from oclp.models import RecordReference
from oclp.profiles import (
    DATASET_SNAPSHOT_PROFILE,
    RELEASE_MANIFEST_PROFILE,
    RUN_PROFILE,
    DatasetSnapshotManifest,
    ReleaseManifestBinding,
    RunBinding,
    run_timeline,
)
from pydantic import ValidationError

RECORD_KINDS = (
    "artifact",
    "artifact_set",
    "computation",
    "execution",
    "evidence",
    "event",
)


@dataclass(frozen=True)
class _InvocationSummary:
    """Human-readable identity for an Execution node."""

    locator: str
    display_name: str
    timeline: _InvocationTimeline
    legacy: bool


@dataclass(frozen=True)
class _InvocationTimeline:
    """Portable profile chronology or an honestly labeled generic fallback."""

    kind: Literal["run", "generic", "none"]
    started_at: datetime | None = None
    completed_at: datetime | None = None
    first_event_at: datetime | None = None
    last_event_at: datetime | None = None

    @property
    def ordering_at(self) -> datetime | None:
        return self.started_at or self.first_event_at

    def model_dump(self) -> dict[str, str | None]:
        return {
            "kind": self.kind,
            "started_at": _timestamp(self.started_at),
            "completed_at": _timestamp(self.completed_at),
            "first_event_at": _timestamp(self.first_event_at),
            "last_event_at": _timestamp(self.last_event_at),
        }


@dataclass(frozen=True)
class _InvocationExecutionSummary:
    """CYCLOPS's read-only projection of one Execution's terminal lifecycle."""

    status: str
    diagnostic: dict[str, object] | None


@dataclass(frozen=True)
class _LifecycleRun:
    """One run-navigation unit, derived from a profile or legacy hierarchy."""

    id: str
    record_id: str
    label: str
    anchor_execution: str
    execution_depths: dict[str, int]
    timeline: _InvocationTimeline
    profile_backed: bool


@dataclass(frozen=True)
class _InferenceService:
    """A CYCLOPS-only rollup of request-scoped Executions for one release.

    The individual Executions, request Artifacts, response Artifacts, and
    Events remain the durable OCLP facts.  This projection exists solely so a
    release-centred lineage can present a serving process without rendering a
    new top-level run for every HTTP request.
    """

    id: str
    release_record_id: str
    label: str
    model_record_id: str
    execution_ids: tuple[str, ...]
    hidden_node_ids: tuple[str, ...]


@dataclass(frozen=True)
class OclpProjectGraph:
    """An immutable, API-ready projection of one OCLP record store."""

    root: Path
    # ``records`` is keyed by the Core record UUID.  The catalog's canonical
    # JSON hash remains useful local integrity metadata, but is deliberately
    # not graph identity and never participates in reference resolution.
    records: dict[str, Any]
    record_digests: dict[str, str]
    nodes: tuple[dict[str, str], ...]
    reference_edges: tuple[dict[str, str], ...]
    derivation_edges: tuple[dict[str, str], ...]
    collection_edges: tuple[dict[str, str], ...]
    execution_summaries: dict[str, _InvocationSummary]
    execution_states: dict[str, _InvocationExecutionSummary]

    def summary(self) -> dict[str, object]:
        """Return lightweight project counts for an explorer landing view."""

        return {
            "root": str(self.root),
            "record_count": len(self.records),
            "counts": dict(
                sorted(Counter(record.kind for record in self.records.values()).items())
            ),
            "node_count": len(self.nodes),
            "derivation_edge_count": len(self.derivation_edges),
            "reference_edge_count": len(self.reference_edges),
            "incomplete_execution_count": sum(
                record.kind == "execution"
                and self.execution_states[digest].status == "incomplete"
                for digest, record in self.records.items()
            ),
        }

    def computations_payload(self) -> dict[str, object]:
        """Return independently navigable connected derivation components."""

        computations = []
        for component_id, node_ids in self._components().items():
            executions = [digest for digest in node_ids if self.records[digest].kind == "execution"]
            display_names = sorted(
                {self.execution_summaries[digest].display_name for digest in executions}
            )
            execution_count = len(executions)
            computations.append(
                {
                    "id": component_id,
                    "label": _computation_label(display_names, execution_count),
                    "execution_count": execution_count,
                    "artifact_count": sum(
                        self.records[digest].kind == "artifact" for digest in node_ids
                    ),
                    "edge_count": sum(
                        edge["source"] in node_ids and edge["target"] in node_ids
                        for edge in self.derivation_edges
                    ),
                }
            )
        return {"computations": computations}

    def runs_payload(self) -> dict[str, object]:
        """Return profile-identified or legacy-hierarchy lifecycle runs."""

        runs = []
        lifecycle_runs = self._lifecycle_runs()
        for run_id in self._run_roots():
            lifecycle_run = lifecycle_runs[run_id]
            execution_depths = lifecycle_run.execution_depths
            execution_digests = set(execution_depths)
            data_node_ids = self._invocation_data_node_ids(execution_digests)
            status_digests = (
                execution_digests
                if lifecycle_run.profile_backed
                else {
                    digest for digest, depth in execution_depths.items() if depth > 0
                }
                or {lifecycle_run.anchor_execution}
            )
            runs.append(
                {
                    "id": lifecycle_run.id,
                    "record_id": lifecycle_run.record_id,
                    "label": lifecycle_run.label,
                    "timeline": lifecycle_run.timeline.model_dump(),
                    "execution_count": len(execution_digests),
                    "artifact_count": sum(
                        self.records[digest].kind == "artifact" for digest in data_node_ids
                    ),
                    "status_counts": dict(
                        sorted(
                            Counter(
                                self.execution_states[digest].status for digest in status_digests
                            ).items()
                        )
                    ),
                    "executions": [
                        {
                            "id": digest,
                            "record_id": self.records[digest].id,
                            "label": self.execution_summaries[digest].display_name,
                            "depth": execution_depths[digest],
                            "status": self.execution_states[digest].status,
                            "diagnostic": self.execution_states[digest].diagnostic,
                        }
                        for digest in sorted(
                            execution_digests,
                            key=lambda digest: (
                                execution_depths[digest],
                                self.execution_summaries[digest].timeline.ordering_at
                                or datetime.max.replace(tzinfo=UTC),
                                self.records[digest].id,
                            ),
                        )
                    ],
                }
            )
        return {"runs": runs}

    def run_lineage_roots(self, run_id: str) -> tuple[str, ...]:
        """Return lifecycle runs joined by explicit Artifact handoffs."""

        return self._run_lineage_run_ids(run_id)

    def inference_services_payload(self) -> list[dict[str, object]]:
        """Return release-backed serving aggregates derived from real bindings.

        A request belongs to an Inference service only when all of these facts
        are present in immutable records:

        * its Execution's named ``model_release`` input names a recorded
          ArtifactSet; and
        * that set has a member named or role-labelled ``model``.

        This deliberately avoids inferring a service from a computation name,
        a locator, a loose artifact-name match, or an application parameter.
        The execution therefore retains its genuine ArtifactSet -> Execution
        data edge. The resulting aggregate is CYCLOPS presentation metadata,
        not an OCLP Core record or relation.
        """

        releases = {
            record_id: record
            for record_id, record in self.records.items()
            if record.kind == "artifact_set"
        }

        grouped: dict[str, dict[str, object]] = {}
        for execution_id, execution in self.records.items():
            if execution.kind != "execution":
                continue
            release_inputs = {
                _reference_id(reference)
                for reference in execution.inputs.get("model_release", ())
            }
            release_inputs.discard(None)
            if len(release_inputs) != 1:
                continue
            release_record_id = next(iter(release_inputs))
            release = releases.get(release_record_id)
            if release is None:
                continue
            model_members = {
                _reference_id(member.artifact)
                for member in release.members
                if member.name == "model" or member.role == "model"
            }
            model_members.discard(None)
            if len(model_members) != 1:
                continue
            model_record_id = next(iter(model_members))
            entry = grouped.setdefault(
                release_record_id,
                {
                    "release_record_id": release_record_id,
                    "label": release.name or release_record_id,
                    "model_record_id": model_record_id,
                    "release_node_ids": {
                        release_record_id,
                        *(
                            _reference_id(member.artifact)
                            for member in release.members
                        ),
                    }
                    - {None},
                    "execution_ids": [],
                },
            )
            entry["execution_ids"].append(execution_id)

        services: list[_InferenceService] = []
        for release_record_id, entry in grouped.items():
            execution_ids = tuple(
                sorted(
                    entry["execution_ids"],
                    key=lambda record_id: (
                        self.execution_summaries[record_id].timeline.ordering_at
                        or datetime.max.replace(tzinfo=UTC),
                        self.records[record_id].id,
                    ),
                )
            )
            release_node_ids = set(entry["release_node_ids"])
            hidden_node_ids = self._inference_service_hidden_node_ids(
                set(execution_ids),
                release_node_ids,
            )
            services.append(
                _InferenceService(
                    id=f"inference-service:{release_record_id}",
                    release_record_id=str(entry["release_record_id"]),
                    label=str(entry["label"]),
                    model_record_id=str(entry["model_record_id"]),
                    execution_ids=execution_ids,
                    hidden_node_ids=tuple(sorted(hidden_node_ids)),
                )
            )

        return [
            {
                "id": service.id,
                "release_record_id": service.release_record_id,
                "label": service.label,
                "model_record_id": service.model_record_id,
                "execution_ids": list(service.execution_ids),
                "hidden_node_ids": list(service.hidden_node_ids),
                "request_count": len(service.execution_ids),
                "status_counts": dict(
                    sorted(
                        Counter(
                            self.execution_states[record_id].status
                            for record_id in service.execution_ids
                        ).items()
                    )
                ),
                "timeline": _aggregate_run_timeline(
                    self.execution_summaries[record_id].timeline
                    for record_id in service.execution_ids
                ).model_dump(),
            }
            for service in services
        ]

    def graph_payload(
        self,
        *,
        view: str = "derivation",
        component: str | None = None,
        run: str | None = None,
        execution: str | None = None,
        service: str | None = None,
        lineage: bool = False,
    ) -> dict[str, object]:
        """Return lifecycle, Data DAG, provenance context, timeline, or references."""

        if service is not None:
            if view == "run":
                nodes, edges = self._inference_service_view(service)
            elif view == "provenance":
                service_nodes, _ = self._inference_service_view(service)
                nodes, edges = self._provenance_view(
                    component=None,
                    run=None,
                    invocation=None,
                    data_nodes=service_nodes,
                    scoped_execution_ids=set(self._inference_service(service)["execution_ids"]),
                )
            else:
                raise ValueError(
                    "An inference service can only be shown in a run or provenance view"
                )
        else:
            nodes, edges = self._view(
                view,
                component=component,
                run=run,
                invocation=execution,
                lineage=lineage,
            )
        if view not in {"derivation", "provenance", "run"}:
            return {
                "view": view,
                "nodes": list(nodes),
                "edges": list(edges),
                "collection_edges": [],
                "collection_nodes": [],
                "lifecycle_groups": [],
                "inference_services": [],
            }
        visible_node_ids = {node["id"] for node in nodes}
        collection_edges, collection_node_ids = self._collection_overlay(visible_node_ids)
        collection_nodes = [
            {
                **node,
                **({"layer": "data"} if view == "provenance" else {}),
            }
            for node in self.nodes
            if node["id"] in collection_node_ids
        ]
        return {
            "view": view,
            # Collection members are supplied separately.  The client decides
            # whether a collection is expanded without changing the Data DAG.
            "nodes": list(nodes),
            "edges": list(edges),
            "collection_edges": list(collection_edges),
            "collection_nodes": collection_nodes,
            # A lifecycle group is a CYCLOPS presentation boundary around a
            # profile run identity or legacy parent_execution hierarchy. It is
            # not an OCLP record or relation, and never replaces dataflow.
            "lifecycle_groups": (
                self._inference_service_groups(service, visible_node_ids)
                if service is not None
                else self._run_presentation_groups(
                    run,
                    visible_node_ids,
                    include_lineage=lineage,
                )
            )
            if view == "run"
            else [],
            "inference_services": self._visible_inference_services(visible_node_ids)
            if view == "run"
            else [],
        }

    def _inference_service_view(
        self,
        service_id: str,
    ) -> tuple[tuple[dict[str, str], ...], tuple[dict[str, str], ...]]:
        """Show one service's real request materializations, not its lineage.

        The containing ArtifactSet is itself the Execution input, so the
        returned records already contain the honest release handoff. Training
        Executions are intentionally out of scope: they belong to a sibling
        run in the same lineage, not to the serving process itself.
        """

        service = self._inference_service(service_id)
        execution_ids = set(service["execution_ids"])
        node_ids = self._lifecycle_node_ids(execution_ids)
        edges = tuple(
            edge
            for edge in (*self.derivation_edges, *self.reference_edges)
            if edge["relation"] in {"consumes", "produces", "computation"}
            and edge["source"] in node_ids
            and edge["target"] in node_ids
        )
        return (
            tuple(node for node in self.nodes if node["id"] in node_ids),
            tuple(sorted(edges, key=lambda edge: (edge["relation"], edge["id"]))),
        )

    def _inference_service(self, service_id: str) -> dict[str, object]:
        for service in self.inference_services_payload():
            if service["id"] == service_id:
                return service
        raise ValueError(f"Unknown inference service: {service_id}")

    def _inference_service_groups(
        self,
        service_id: str,
        visible_node_ids: set[str],
    ) -> list[dict[str, object]]:
        """Bound one focused serving graph without claiming it is a lifecycle."""

        service = self._inference_service(service_id)
        return [
            {
                "id": f"inference-service:{service_id}",
                "root_id": service_id,
                "title": "Inference service",
                "label": service["label"],
                "member_ids": sorted(visible_node_ids),
            }
        ]

    def _run_presentation_groups(
        self,
        run: str | None,
        visible_node_ids: set[str],
        *,
        include_lineage: bool,
    ) -> list[dict[str, object]]:
        """Add a lineage boundary around sibling lifecycle/service graphs."""

        groups = self._lifecycle_groups(visible_node_ids)
        if run is None or not include_lineage:
            return groups
        selected_run = self._resolve_run(run)
        lineage_run_ids = self._run_lineage_run_ids(selected_run)
        if len(lineage_run_ids) < 2:
            return groups
        lifecycle_runs = self._lifecycle_runs()
        groups.insert(
            0,
            {
                "id": f"lineage:{min(lineage_run_ids)}",
                "root_id": lifecycle_runs[selected_run].anchor_execution,
                "title": "Lineage",
                "label": "Connected release and service runs",
                "member_ids": sorted(visible_node_ids),
            },
        )
        return groups

    def _visible_inference_services(
        self,
        visible_node_ids: set[str],
    ) -> list[dict[str, object]]:
        """Keep only service aggregates represented by the selected run view."""

        services = []
        for service in self.inference_services_payload():
            execution_ids = set(service["execution_ids"])
            if not execution_ids & visible_node_ids:
                continue
            source_node_id = (
                service["release_record_id"]
                if service["release_record_id"] in visible_node_ids
                else service["model_record_id"]
                if service["model_record_id"] in visible_node_ids
                else None
            )
            services.append(
                {
                    **service,
                    "source_node_id": source_node_id,
                    "hidden_node_ids": [
                        digest
                        for digest in service["hidden_node_ids"]
                        if digest in visible_node_ids
                    ],
                }
            )
        return services

    def _inference_service_hidden_node_ids(
        self,
        execution_digests: set[str],
        release_node_ids: set[str],
    ) -> set[str]:
        """Return request-private materializations that a service rollup hides.

        The release ArtifactSet and its members remain visible: they are
        shared, release-facing data that anchor the aggregate back to the
        training/release run. Request and response Artifacts, their
        Computations, and request provenance are private to the expanded view
        and can be safely collapsed.
        """

        hidden = set(execution_digests)
        for edge in self.derivation_edges:
            if edge["relation"] == "produces" and edge["source"] in execution_digests:
                hidden.add(edge["target"])
            elif (
                edge["relation"] == "consumes"
                and edge["target"] in execution_digests
                and edge["source"] not in release_node_ids
            ):
                hidden.add(edge["source"])
        for edge in self.reference_edges:
            if edge["relation"] == "computation" and edge["source"] in execution_digests:
                hidden.add(edge["target"])

        # Provenance is only supplied when the user enables its overlay.  Walk
        # its local Event/Evidence relationships here so collapsing the service
        # never leaves a stack of orphaned request event cards behind.
        changed = True
        while changed:
            changed = False
            for edge in self.reference_edges:
                source = self.records[edge["source"]]
                target = self.records[edge["target"]]
                if source.kind not in {"event", "evidence"} and target.kind not in {
                    "event",
                    "evidence",
                }:
                    continue
                if edge["source"] in hidden and edge["target"] not in hidden:
                    hidden.add(edge["target"])
                    changed = True
                elif edge["target"] in hidden and edge["source"] not in hidden:
                    hidden.add(edge["source"])
                    changed = True
        return hidden

    def record_payload(self, record_id: str) -> dict[str, object]:
        """Return one stored record by its Core UUID."""

        record = self.records[record_id]
        return {
            "id": record_id,
            "record_digest": f"sha256:{self.record_digests[record_id]}",
            "record": record.model_dump(mode="json", exclude_none=True),
        }

    def focused_payload(
        self,
        record_id: str,
        *,
        depth: int,
        view: str = "derivation",
        component: str | None = None,
        run: str | None = None,
        execution: str | None = None,
    ) -> dict[str, object]:
        """Return the undirected lineage neighborhood around one record UUID."""

        if record_id not in self.records:
            raise KeyError(record_id)
        nodes, edges = self._view(
            view,
            component=component,
            run=run,
            invocation=execution,
        )
        adjacent: dict[str, set[str]] = {node["id"]: set() for node in nodes}
        if record_id not in adjacent:
            return {
                "view": view,
                "nodes": [],
                "edges": [],
                "collection_edges": [],
                "collection_nodes": [],
                "lifecycle_groups": [],
                "inference_services": [],
            }
        for edge in edges:
            adjacent[edge["source"]].add(edge["target"])
            adjacent[edge["target"]].add(edge["source"])
        selected = {record_id}
        frontier = deque([(record_id, 0)])
        while frontier:
            current, distance = frontier.popleft()
            if distance == depth:
                continue
            for neighbor in adjacent[current]:
                if neighbor not in selected:
                    selected.add(neighbor)
                    frontier.append((neighbor, distance + 1))
        payload: dict[str, object] = {
            "view": view,
            "nodes": [node for node in nodes if node["id"] in selected],
            "edges": [
                edge for edge in edges if edge["source"] in selected and edge["target"] in selected
            ],
        }
        if view in {"derivation", "provenance", "run"}:
            collection_edges, collection_node_ids = self._collection_overlay(selected)
            collection_nodes = [
                {
                    **node,
                    **({"layer": "data"} if view == "provenance" else {}),
                }
                for node in self.nodes
                if node["id"] in collection_node_ids
            ]
            payload["collection_edges"] = collection_edges
            payload["collection_nodes"] = collection_nodes
            payload["lifecycle_groups"] = (
                self._lifecycle_groups(selected) if view == "run" else []
            )
            payload["inference_services"] = (
                self._visible_inference_services(selected) if view == "run" else []
            )
        else:
            payload["collection_edges"] = []
            payload["collection_nodes"] = []
            payload["lifecycle_groups"] = []
            payload["inference_services"] = []
        return payload

    def _lifecycle_groups(self, visible_node_ids: set[str]) -> list[dict[str, object]]:
        """Return visual lifecycle boundaries for visible run materializations."""

        groups: list[dict[str, object]] = []
        lifecycle_runs = self._lifecycle_runs()
        for run_id in self._run_roots():
            lifecycle_run = lifecycle_runs[run_id]
            depths = lifecycle_run.execution_depths
            lifecycle_node_ids = self._lifecycle_node_ids(set(depths))
            member_ids = [
                record_id
                for record_id in sorted(
                    lifecycle_node_ids,
                    key=lambda record_id: (
                        0 if record_id == lifecycle_run.anchor_execution else 1,
                        depths.get(record_id, -1),
                        self.execution_summaries[record_id].timeline.ordering_at
                        if record_id in self.execution_summaries
                        else None
                        or datetime.max.replace(tzinfo=UTC),
                        self.records[record_id].id,
                    ),
                )
                if record_id in visible_node_ids
            ]
            if lifecycle_run.anchor_execution not in member_ids or len(member_ids) < 2:
                continue
            groups.append(
                {
                    "id": f"run:{run_id}",
                    "root_id": lifecycle_run.anchor_execution,
                    "label": (
                        lifecycle_run.label
                        if lifecycle_run.profile_backed
                        else self.execution_summaries[
                            lifecycle_run.anchor_execution
                        ].display_name
                    ),
                    "member_ids": member_ids,
                }
            )
        return groups

    def _collection_overlay(
        self,
        visible_node_ids: set[str],
    ) -> tuple[tuple[dict[str, str], ...], set[str]]:
        """Return a visible collection's exact member overlay.

        An ArtifactSet and a dataset-snapshot Artifact are both direct Data
        DAG nodes.  Their members are inventory context, so a client can
        reveal or hide them without replacing the collection's real
        ``consumes`` or ``produces`` edge.  Members outside the selected Data
        DAG are returned as contextual nodes for an expanded collection.
        """

        edges = tuple(edge for edge in self.collection_edges if edge["source"] in visible_node_ids)
        member_ids = {edge["target"] for edge in edges}
        return edges, member_ids - visible_node_ids

    def _view(
        self,
        view: str,
        *,
        component: str | None = None,
        run: str | None = None,
        invocation: str | None = None,
        lineage: bool = False,
    ) -> tuple[tuple[dict[str, str], ...], tuple[dict[str, str], ...]]:
        if view == "run":
            return self._run_view(run, include_lineage=lineage)
        if view == "provenance":
            return self._provenance_view(
                component,
                run=run,
                invocation=invocation,
                include_lineage=lineage,
            )
        if view == "timeline":
            return self._timeline_view(run, invocation=invocation)
        if view == "reference":
            node_ids = self._component_node_ids(component)
            if component is None:
                return self.nodes, self.reference_edges
            changed = True
            while changed:
                changed = False
                for edge in self.reference_edges:
                    if edge["source"] in node_ids or edge["target"] in node_ids:
                        before = len(node_ids)
                        node_ids.update((edge["source"], edge["target"]))
                        changed = changed or len(node_ids) != before
            return (
                tuple(node for node in self.nodes if node["id"] in node_ids),
                tuple(
                    edge
                    for edge in self.reference_edges
                    if edge["source"] in node_ids and edge["target"] in node_ids
                ),
            )
        if view == "derivation":
            derivation_node_ids = self._data_node_ids(
                component=component,
                run=run,
                invocation=invocation,
            )
            derivation_edges = tuple(
                edge
                for edge in self.derivation_edges
                if edge["source"] in derivation_node_ids and edge["target"] in derivation_node_ids
            )
            # A focused Execution view remains its strict Artifact →
            # Execution → Artifact materialization. A direct release is
            # related to a run through member provenance, but it was not
            # produced by this Execution; include it only in a run/component
            # projection where that broader publication context is requested.
            if invocation is None:
                derivation_node_ids.update(
                    self._release_publication_node_ids(
                        {
                            edge["target"]
                            for edge in derivation_edges
                            if edge["relation"] == "produces"
                        }
                    )
                )
            release_manifest_edges = tuple(
                edge
                for edge in self.reference_edges
                if edge["relation"] == "release-manifest"
                and edge["source"] in derivation_node_ids
                and edge["target"] in derivation_node_ids
            )
            return (
                tuple(node for node in self.nodes if node["id"] in derivation_node_ids),
                tuple(
                    sorted(
                        (*derivation_edges, *release_manifest_edges),
                        key=lambda edge: (edge["relation"], edge["id"]),
                    )
                ),
            )
        raise ValueError(f"Unknown graph view: {view}")

    def _timeline_view(
        self,
        run: str | None,
        *,
        invocation: str | None,
    ) -> tuple[tuple[dict[str, str], ...], tuple[dict[str, str], ...]]:
        """Project the selected Execution or connected run chronology onto time.

        Direct inputs and outputs remain visible as Data DAG bindings. Records
        with an asserted Core ``created_at`` sit at their own time; inputs
        without that timestamp are explicitly marked untimed so the client can
        place them before the chronology without inventing a date.
        """

        root_digest = self._resolve_run(run)
        invocation_depths = self._run_lineage_invocation_depths(root_digest)
        if invocation is not None:
            if invocation not in invocation_depths:
                raise KeyError(f"Execution {invocation} is not part of the selected run")
            invocation_depths = {invocation: invocation_depths[invocation]}
        invocation_ids = set(invocation_depths)
        output_artifact_ids = {
            edge["target"]
            for edge in self.derivation_edges
            if edge["relation"] == "produces" and edge["source"] in invocation_ids
        }
        direct_materialization_ids = self._release_publication_node_ids(
            output_artifact_ids
        )
        evidence_sequence_tiebreakers = _evidence_sequence_tiebreakers(
            self.records,
            self.reference_edges,
        )
        timeline_owner: dict[str, str] = {}
        timeline_roles: dict[str, str] = {}
        timeline_node_ids = set(invocation_ids) | direct_materialization_ids
        for edge in self.reference_edges:
            if (
                edge["relation"] in {"event-execution", "evidence-subject"}
                and edge["target"] in invocation_ids
            ):
                timeline_node_ids.add(edge["source"])
                timeline_owner[edge["source"]] = edge["target"]
        for edge in self.derivation_edges:
            if edge["relation"] == "consumes" and edge["target"] in invocation_ids:
                input_artifact = self.records[edge["source"]]
                if input_artifact.kind not in {"artifact", "artifact_set"}:
                    continue
                timeline_node_ids.add(edge["source"])
                timeline_owner[edge["source"]] = edge["target"]
                timeline_roles[edge["source"]] = "input"
            elif edge["relation"] == "produces" and edge["source"] in invocation_ids:
                output = self.records[edge["target"]]
                if output.kind not in {"artifact", "artifact_set"}:
                    continue
                timeline_node_ids.add(edge["target"])
                timeline_owner[edge["target"]] = edge["source"]
                timeline_roles[edge["target"]] = "output"

        nodes: list[dict[str, str]] = []
        for node in self.nodes:
            digest = node["id"]
            if digest not in timeline_node_ids:
                continue
            record = self.records[digest]
            if record.kind == "execution":
                summary = self.execution_summaries[digest].timeline
                timeline_at = _timestamp(summary.ordering_at)
                timeline_end_at = _timestamp(summary.completed_at or summary.last_event_at)
                nodes.append(
                    {
                        **node,
                        "layer": "timeline",
                        "timeline_lane": digest,
                        "timeline_depth": str(invocation_depths[digest]),
                        **({"timeline_at": timeline_at} if timeline_at is not None else {}),
                        **(
                            {"timeline_end_at": timeline_end_at}
                            if timeline_end_at is not None
                            else {}
                        ),
                    }
                )
                continue
            if digest in direct_materialization_ids:
                created_at = _timestamp(record.created_at)
                nodes.append(
                    {
                        **node,
                        "layer": "timeline",
                        "timeline_lane": f"publication:{digest}",
                        "timeline_depth": str(max(invocation_depths.values()) + 1),
                        "timeline_role": "publication",
                        **({"timeline_at": created_at} if created_at is not None else {}),
                    }
                )
                continue
            owner = timeline_owner.get(digest)
            if owner is not None:
                nodes.append(
                    {
                        **node,
                        "layer": "timeline",
                        "timeline_lane": owner,
                        "timeline_depth": str(invocation_depths[owner]),
                        **(
                            {"timeline_role": timeline_roles[digest]}
                            if digest in timeline_roles
                            else {}
                        ),
                        **(
                            {"timeline_sequence": evidence_sequence_tiebreakers[digest]}
                            if digest in evidence_sequence_tiebreakers
                            else {}
                        ),
                    }
                )

        return (
            tuple(nodes),
            tuple(
                sorted(
                    (
                        *(
                            edge
                            for edge in self.reference_edges
                            if edge["relation"] == "orchestrates"
                            and edge["source"] in invocation_ids
                            and edge["target"] in invocation_ids
                        ),
                        *(
                            edge
                            for edge in self.derivation_edges
                            if edge["relation"] in {"consumes", "produces"}
                            and (
                                edge["target"] in invocation_ids
                                if edge["relation"] == "consumes"
                                else edge["source"] in invocation_ids
                            )
                            and edge["source"] in timeline_node_ids
                            and edge["target"] in timeline_node_ids
                        ),
                        *(
                            edge
                            for edge in self.reference_edges
                            if edge["relation"] == "release-manifest"
                            and edge["source"] in timeline_node_ids
                            and edge["target"] in timeline_node_ids
                        ),
                    ),
                    key=lambda edge: (edge["relation"], edge["id"]),
                )
            ),
        )

    def _provenance_view(
        self,
        component: str | None,
        *,
        run: str | None,
        invocation: str | None,
        data_nodes: tuple[dict[str, str], ...] | None = None,
        scoped_execution_ids: set[str] | None = None,
        include_lineage: bool = False,
    ) -> tuple[tuple[dict[str, str], ...], tuple[dict[str, str], ...]]:
        """Overlay non-dataflow Core context on the same Data DAG nodes.

        Input and output references are deliberately omitted here: their
        ``consumes`` and ``produces`` Data DAG bindings already express the
        relation.  ArtifactSet membership remains an optional navigation
        overlay, rather than a second provenance edge.
        """

        if data_nodes is None and include_lineage and run is not None and invocation is None:
            # A Lineage selection is the explicit aggregate of every
            # handoff-connected materialization. Its provenance must use that
            # same complete data graph—not quietly collapse to the initially
            # selected lifecycle run.
            data_nodes, _ = self._run_view(run, include_lineage=True)
            scoped_execution_ids = set(
                self._run_lineage_invocation_depths(self._resolve_run(run))
            )
        elif data_nodes is None:
            data_nodes, _ = self._view(
                "derivation",
                component=component,
                run=run,
                invocation=invocation,
            )
        data_node_ids = {node["id"] for node in data_nodes}
        context_node_ids = set(data_node_ids)
        scoped_invocations = (
            set(scoped_execution_ids)
            if scoped_execution_ids is not None
            else {
                digest for digest in data_node_ids if self.records[digest].kind == "execution"
            }
        )
        include_orchestration = invocation is None and (run is not None or component is not None)
        if include_orchestration:
            changed_invocations = True
            while changed_invocations:
                changed_invocations = False
                for edge in self.reference_edges:
                    if (
                        edge["relation"] == "orchestrates"
                        and edge["source"] in scoped_invocations
                        and edge["target"] not in scoped_invocations
                    ):
                        scoped_invocations.add(edge["target"])
                        changed_invocations = True
        changed = True
        while changed:
            changed = False
            for edge in self.reference_edges:
                if edge["relation"] in {
                    "input",
                    "output",
                    "contains",
                    "event-reference",
                }:
                    continue
                if edge["relation"] == "orchestrates" and not include_orchestration:
                    continue
                if any(
                    self.records[endpoint].kind == "execution"
                    and endpoint not in scoped_invocations
                    for endpoint in (edge["source"], edge["target"])
                ):
                    continue
                if edge["source"] in context_node_ids or edge["target"] in context_node_ids:
                    before = len(context_node_ids)
                    context_node_ids.update((edge["source"], edge["target"]))
                    changed = changed or len(context_node_ids) != before

        data_edges = tuple(
            edge
            for edge in self.derivation_edges
            if edge["source"] in data_node_ids and edge["target"] in data_node_ids
        )
        context_edges = tuple(
            edge
            for edge in self.reference_edges
            if edge["source"] in context_node_ids
            and edge["target"] in context_node_ids
            and edge["relation"] not in {"input", "output", "contains", "event-reference"}
        )
        evidence_sequence_tiebreakers = _evidence_sequence_tiebreakers(
            self.records,
            self.reference_edges,
        )
        nodes = tuple(
            {
                **node,
                "layer": "data" if node["id"] in data_node_ids else "provenance",
                **(
                    {"timeline_sequence": evidence_sequence_tiebreakers[node["id"]]}
                    if node["id"] in evidence_sequence_tiebreakers
                    else {}
                ),
            }
            for node in self.nodes
            if node["id"] in context_node_ids
        )
        return nodes, tuple(
            sorted(
                (*data_edges, *context_edges),
                key=lambda edge: (edge["relation"], edge["id"]),
            )
        )

    def _run_view(
        self,
        run: str | None,
        *,
        include_lineage: bool = False,
    ) -> tuple[tuple[dict[str, str], ...], tuple[dict[str, str], ...]]:
        """Show the real Executions and data bindings in one run.

        A profile-backed run is a common ``profiles.run.run_id`` claimed
        by real Executions. Legacy records retain their explicit
        ``parent_execution`` hierarchy. A caller must explicitly request the
        larger lineage scope; selecting a Run never silently appends a
        downstream service or other handoff run.
        """

        root_digest = self._resolve_run(run)
        execution_digests = set(
            self._run_lineage_invocation_depths(root_digest)
            if include_lineage
            else self._run_invocation_depths(root_digest)
        )
        data_node_ids = self._lifecycle_node_ids(execution_digests)
        edges = tuple(
            edge
            for edge in (*self.derivation_edges, *self.reference_edges)
            if edge["relation"]
            in {"consumes", "produces", "computation", "release-manifest"}
            and edge["source"] in data_node_ids
            and edge["target"] in data_node_ids
        )
        return (
            tuple(node for node in self.nodes if node["id"] in data_node_ids),
            tuple(sorted(edges, key=lambda edge: (edge["relation"], edge["id"]))),
        )

    def _lifecycle_node_ids(self, execution_digests: set[str]) -> set[str]:
        """Return records directly materialized by one selected lifecycle run.

        The lifecycle container represents the complete run-facing graph:
        every selected Execution, the Artifacts it consumes or produces,
        ArtifactSets emitted as outputs, and the Computations that describe
        that work. Implementation/source artifacts are intentionally omitted;
        they are provenance context rather than runtime materializations.
        """

        node_ids = self._invocation_data_node_ids(execution_digests)
        node_ids.update(
            edge["target"]
            for edge in self.reference_edges
            if edge["relation"] == "computation" and edge["source"] in execution_digests
        )
        output_artifact_ids = {
            edge["target"]
            for edge in self.derivation_edges
            if edge["relation"] == "produces" and edge["source"] in execution_digests
        }
        node_ids.update(self._release_publication_node_ids(output_artifact_ids))
        return node_ids

    def _release_publication_node_ids(
        self,
        output_artifact_ids: set[str],
    ) -> set[str]:
        """Return releases assembled from an Execution's actual outputs.

        Publishing an ArtifactSet is not a Computation and must not claim the
        Execution-only run profile. Its association is instead derived
        from its explicit membership: a release is relevant to a run when one
        of its members was emitted by that run. A release-manifest profile then
        provides the one-way, non-cyclic link from its sidecar Artifact to the
        exact set it describes.
        """

        artifact_set_ids = self._artifact_set_node_ids(output_artifact_ids)
        manifest_ids = {
            edge["source"]
            for edge in self.reference_edges
            if edge["relation"] == "release-manifest"
            and edge["target"] in artifact_set_ids
        }
        return artifact_set_ids | manifest_ids

    def _artifact_set_node_ids(self, output_artifact_ids: set[str]) -> set[str]:
        """Return release sets bound to this computation's output scope.

        New producers bind the ArtifactSet itself as an Invocation output. That
        explicit association is required when two runs publish identical
        content-addressed member Artifacts. Older stores lack that binding, so
        their sets retain the narrower member-output fallback *only when no
        Invocation explicitly produced the set*. A set produced later in the
        run can contain an earlier step's output as one of its members; it is
        not therefore an output of that earlier step.
        """

        direct_output_sets = {
            digest for digest in output_artifact_ids if self.records[digest].kind == "artifact_set"
        }
        if direct_output_sets:
            return direct_output_sets

        explicitly_produced_sets = {
            edge["target"]
            for edge in self.derivation_edges
            if edge["relation"] == "produces"
            and self.records[edge["target"]].kind == "artifact_set"
        }
        return {
            edge["source"]
            for edge in self.collection_edges
            if edge["target"] in output_artifact_ids
            and self.records[edge["source"]].kind == "artifact_set"
            and edge["source"] not in explicitly_produced_sets
        }

    def _data_node_ids(
        self,
        *,
        component: str | None,
        run: str | None,
        invocation: str | None,
    ) -> set[str]:
        """Resolve the narrowest requested data scope without inference."""

        if invocation is not None:
            if invocation not in self.records or self.records[invocation].kind != "execution":
                raise ValueError(f"Unknown execution: {invocation}")
            if run is not None and invocation not in self._run_lineage_invocation_depths(
                self._resolve_run(run)
            ):
                raise ValueError(f"Execution {invocation} is not part of run {run}")
            return self._invocation_data_node_ids({invocation})
        if run is not None:
            # A selected Run owns only its own direct materialization.  A
            # lineage is a deliberately broader presentation selected through
            # ``view=run&lineage=true``; provenance for a Run must not pull a
            # sibling serving run into the overlay and leave its events
            # visually detached from the selected graph.
            return self._run_data_node_ids(self._resolve_run(run))
        return self._component_node_ids(component)

    def _lifecycle_runs(self) -> dict[str, _LifecycleRun]:
        """Project valid profile ``run_id`` claims, with a legacy fallback.

        A profile run contains only real Executions. It does not manufacture a
        controller Execution merely to give an orchestrator a navigation root.
        Existing records that predate ``profiles.run.run_id`` continue to
        use their explicit parent-execution hierarchy.
        """

        profile_members: dict[str, list[str]] = {}
        profile_names: dict[str, str | None] = {}
        profile_execution_ids: set[str] = set()
        for digest, record in self.records.items():
            if record.kind != "execution":
                continue
            binding_data = (record.profiles or {}).get(RUN_PROFILE)
            if binding_data is None:
                continue
            try:
                binding = RunBinding.model_validate(binding_data)
            except ValidationError:
                continue
            run_id = str(binding.run_id)
            profile_members.setdefault(run_id, []).append(digest)
            profile_execution_ids.add(digest)
            existing_name = profile_names.get(run_id)
            if existing_name is None:
                profile_names[run_id] = binding.run_name
            else:
                profile_names.setdefault(run_id, binding.run_name)

        runs: dict[str, _LifecycleRun] = {}
        for run_id, members in profile_members.items():
            ordered_members = sorted(
                members,
                key=lambda digest: (
                    self.execution_summaries[digest].timeline.ordering_at
                    or datetime.max.replace(tzinfo=UTC),
                    self.records[digest].id,
                ),
            )
            anchor = ordered_members[0]
            runs[run_id] = _LifecycleRun(
                id=run_id,
                record_id=run_id,
                label=profile_names[run_id] or _profile_run_label(run_id),
                anchor_execution=anchor,
                execution_depths={digest: 0 for digest in ordered_members},
                timeline=_aggregate_run_timeline(
                    self.execution_summaries[digest].timeline
                    for digest in ordered_members
                ),
                profile_backed=True,
            )

        legacy_execution_ids = {
            digest
            for digest, record in self.records.items()
            if record.kind == "execution" and digest not in profile_execution_ids
        }
        legacy_children = {
            edge["target"]
            for edge in self.reference_edges
            if edge["relation"] == "orchestrates"
            and edge["source"] in legacy_execution_ids
            and edge["target"] in legacy_execution_ids
        }
        for root_digest in legacy_execution_ids - legacy_children:
            depths = self._legacy_run_invocation_depths(
                root_digest,
                allowed=legacy_execution_ids,
            )
            runs[root_digest] = _LifecycleRun(
                id=root_digest,
                record_id=self.records[root_digest].id,
                label=_run_label(
                    self.execution_summaries[root_digest].display_name,
                    self._run_identifier(root_digest),
                ),
                anchor_execution=root_digest,
                execution_depths=depths,
                timeline=self.execution_summaries[root_digest].timeline,
                profile_backed=False,
            )
        return runs

    def _run_roots(self) -> tuple[str, ...]:
        """Return lifecycle run identities ordered by their first Execution."""

        runs = self._lifecycle_runs()
        return tuple(
            sorted(
                runs,
                key=lambda run_id: (
                    runs[run_id].timeline.ordering_at
                    or datetime.min.replace(tzinfo=UTC),
                    run_id,
                ),
                reverse=True,
            )
        )

    def _resolve_run(self, run: str | None) -> str:
        roots = self._run_roots()
        if run is None:
            if roots:
                return roots[0]
            raise ValueError("No lifecycle runs are available")
        if run not in roots:
            raise ValueError(f"Unknown lifecycle run: {run}")
        return run

    def _run_invocation_depths(self, run_id: str) -> dict[str, int]:
        """Return the real Executions directly claimed by one lifecycle run."""

        try:
            return self._lifecycle_runs()[run_id].execution_depths
        except KeyError as error:
            raise ValueError(f"Unknown lifecycle run: {run_id}") from error

    def _legacy_run_invocation_depths(
        self,
        root_digest: str,
        *,
        allowed: set[str],
    ) -> dict[str, int]:
        """Return the explicit Execution hierarchy for pre-profile records."""

        children: dict[str, list[str]] = {}
        for edge in self.reference_edges:
            if (
                edge["relation"] == "orchestrates"
                and edge["source"] in allowed
                and edge["target"] in allowed
            ):
                children.setdefault(edge["source"], []).append(edge["target"])
        depths = {root_digest: 0}
        frontier = deque([root_digest])
        while frontier:
            parent = frontier.popleft()
            for child in sorted(children.get(parent, [])):
                if child not in depths:
                    depths[child] = depths[parent] + 1
                    frontier.append(child)
        return depths

    def _run_data_node_ids(self, run_id: str) -> set[str]:
        return self._lifecycle_node_ids(set(self._run_invocation_depths(run_id)))

    def _run_lineage_data_node_ids(self, run_id: str) -> set[str]:
        """Return direct data bindings for all handoff-connected runs."""

        return self._lifecycle_node_ids(
            set(self._run_lineage_invocation_depths(run_id))
        )

    def _run_lineage_run_ids(self, run_id: str) -> tuple[str, ...]:
        """Return runs connected by explicit producer/consumer handoffs.

        Shared, unproduced inputs do not connect runs. Crossing a run boundary
        requires an Artifact or ArtifactSet that one Execution produced and a
        different Execution consumed.
        """

        lifecycle_runs = self._lifecycle_runs()
        if run_id not in lifecycle_runs:
            raise ValueError(f"Unknown lifecycle run: {run_id}")
        runs_by_execution = {
            execution_id: lifecycle_run_id
            for lifecycle_run_id, lifecycle_run in lifecycle_runs.items()
            for execution_id in lifecycle_run.execution_depths
        }
        selected_run_ids = {run_id}
        changed = True
        while changed:
            changed = False
            produced_by_artifact: dict[str, set[str]] = {}
            consumed_by_artifact: dict[str, set[str]] = {}
            for edge in self.derivation_edges:
                if edge["relation"] == "produces":
                    produced_by_artifact.setdefault(edge["target"], set()).add(edge["source"])
                elif edge["relation"] == "consumes":
                    consumed_by_artifact.setdefault(edge["source"], set()).add(edge["target"])
            for artifact_id, consumers in consumed_by_artifact.items():
                producers = produced_by_artifact.get(artifact_id, set())
                producer_run_ids = {
                    runs_by_execution[execution_id]
                    for execution_id in producers
                    if execution_id in runs_by_execution
                }
                # Consuming a set consumes its explicitly declared members as
                # a collection. Those member producer/consumer relationships
                # connect runs without manufacturing a publication Execution
                # or misusing the Execution-only lifecycle profile on the set.
                if self.records[artifact_id].kind == "artifact_set":
                    for membership in self.collection_edges:
                        if membership["source"] != artifact_id:
                            continue
                        producer_run_ids.update(
                            runs_by_execution[execution_id]
                            for execution_id in produced_by_artifact.get(
                                membership["target"], set()
                            )
                            if execution_id in runs_by_execution
                        )
                consumer_run_ids = {
                    runs_by_execution[execution_id]
                    for execution_id in consumers
                    if execution_id in runs_by_execution
                }
                if not producer_run_ids or not consumer_run_ids:
                    continue
                connected_run_ids = producer_run_ids | consumer_run_ids
                if not connected_run_ids & selected_run_ids:
                    continue
                for connected_run_id in connected_run_ids - selected_run_ids:
                    selected_run_ids.add(connected_run_id)
                    changed = True
        return tuple(
            [run_id]
            + sorted(
                selected_run_ids - {run_id},
                key=lambda candidate: (
                    lifecycle_runs[candidate].timeline.ordering_at
                    or datetime.max.replace(tzinfo=UTC),
                    candidate,
                ),
            )
        )

    def _run_lineage_invocation_depths(self, run_id: str) -> dict[str, int]:
        """Return all real Executions in a run's handoff lineage."""

        depths: dict[str, int] = {}
        for selected_run_id in self._run_lineage_run_ids(run_id):
            depths.update(self._run_invocation_depths(selected_run_id))
        return depths

    def _invocation_data_node_ids(self, invocation_digests: set[str]) -> set[str]:
        """Return direct input/output Artifacts for the selected Executions."""

        node_ids = set(invocation_digests)
        for edge in self.derivation_edges:
            if edge["source"] in invocation_digests or edge["target"] in invocation_digests:
                node_ids.update((edge["source"], edge["target"]))
        return node_ids

    def _run_identifier(self, root_digest: str) -> str:
        """Prefer a caller-owned run ID from the root start Event for display."""

        for record in self.records.values():
            if (
                record.kind == "event"
                and record.event_type == "execution-started"
                and record.execution.id == root_digest
                and isinstance(record.data.get("run_id"), str)
            ):
                return record.data["run_id"]
        return self.records[root_digest].id[:8]

    def _components(self) -> dict[str, set[str]]:
        adjacency: dict[str, set[str]] = {
            digest: set() for digest, record in self.records.items() if record.kind == "execution"
        }
        for edge in self.derivation_edges:
            adjacency.setdefault(edge["source"], set()).add(edge["target"])
            adjacency.setdefault(edge["target"], set()).add(edge["source"])
        components: dict[str, set[str]] = {}
        remaining = set(adjacency)
        while remaining:
            seed = min(remaining)
            component = {seed}
            frontier = [seed]
            remaining.remove(seed)
            while frontier:
                current = frontier.pop()
                for neighbor in adjacency[current]:
                    if neighbor in remaining:
                        remaining.remove(neighbor)
                        component.add(neighbor)
                        frontier.append(neighbor)
            components[f"component:{min(component)}"] = component
        return dict(sorted(components.items()))

    def _component_node_ids(self, component: str | None) -> set[str]:
        components = self._components()
        if component is None:
            return set().union(*components.values()) if components else set()
        try:
            return set(components[component])
        except KeyError as error:
            raise ValueError(f"Unknown computation: {component}") from error


def load_project_graph(
    root: Path | str,
    *,
    catalog: DuckdbCatalog | None = None,
) -> OclpProjectGraph:
    """Load all Core records below *root* and project their explicit bindings."""

    root_path = Path(root)
    records, record_digests = _load_records(root_path, catalog=catalog)
    if not records:
        raise ValueError(f"No OCLP records found under {root_path}")
    _validate_project_records(records)
    execution_summaries = _invocation_summaries(records)
    execution_states = _invocation_execution_summaries(
        records,
        execution_summaries,
    )
    derivation_edges = tuple(_derivation_edges(records))
    collection_edges = tuple(_collection_edges(root_path, records))
    nodes = tuple(
        _node(
            record_id,
            record,
            record_digest=record_digests[record_id],
            execution_states=execution_states,
        )
        for record_id, record in sorted(records.items())
    )
    return OclpProjectGraph(
        root=root_path,
        records=records,
        record_digests=record_digests,
        nodes=_mark_dataset_snapshot_nodes(
            _label_derivation_artifacts(nodes, derivation_edges),
            collection_edges,
        ),
        reference_edges=tuple(_reference_edges(records)),
        derivation_edges=derivation_edges,
        collection_edges=collection_edges,
        execution_summaries=execution_summaries,
        execution_states=execution_states,
    )


def _load_records(
    root: Path,
    *,
    catalog: DuckdbCatalog | None,
) -> tuple[dict[str, Any], dict[str, str]]:
    records: dict[str, Any] = {}
    record_digests: dict[str, str] = {}
    for path in _record_paths(root):
        record = _parse_store_record(json.loads(path.read_text()))
        record_digest = path.stem
        if record.id in records:
            raise ValueError(f"Duplicate OCLP record ID {record.id} under {root}")
        records[record.id] = record
        record_digests[record.id] = record_digest
    if catalog is not None:
        # Ingest the already-parsed snapshot. Returning it rather than
        # catalog.records() retains legacy empty-profile records without
        # weakening current SDK producer validation.
        catalog.ingest(records.values())
    return records, record_digests


def _parse_store_record(value: dict[str, Any]) -> Any:
    """Read a pre-null-profile local record without rewriting its identity.

    Early producer records serialized ``profiles: {}``. Current Core producers
    emit ``null`` when no profile is bound, and strict parsing rejects the
    former. CYCLOPS accepts the historical shape only at this storage-read
    boundary, then restores it on an otherwise parsed model while preserving
    its original canonical bytes. References resolve by record UUID, not by
    that local integrity digest.
    """

    if value.get("profiles") != {}:
        return parse_record(value)
    normalized = {**value, "profiles": None}
    record = parse_record(normalized)
    fields = record.__dict__.copy()
    fields["profiles"] = {}
    return type(record).model_construct(**fields)


def _validate_project_records(records: dict[str, Any]) -> None:
    """Validate explicit bindings against the Core UUID identity map."""

    def require(
        reference: RecordReference,
        *,
        kind: str | tuple[str, ...],
        label: str,
    ) -> str:
        record_id = reference.id
        target = records.get(record_id)
        if target is None:
            raise ValueError(f"{label} does not resolve in this record set")
        expected_kinds = (kind,) if isinstance(kind, str) else kind
        if target.kind not in expected_kinds:
            expected_label = " or ".join(expected_kinds)
            raise ValueError(f"{label} must resolve to a {expected_label}, got {target.kind}")
        return record_id

    derivation: dict[str, set[str]] = {}
    orchestration: dict[str, set[str]] = {}
    for record_id, record in records.items():
        if record.kind == "computation":
            implementation = record.implementation
            if implementation.artifact is not None:
                require(
                    implementation.artifact,
                    kind="artifact",
                    label=f"Computation {record.id} implementation artifact",
                )
            overlay = getattr(implementation.source, "overlay", None)
            if overlay is not None:
                require(
                    overlay,
                    kind="artifact_set",
                    label=f"Computation {record.id} Git source overlay",
                )
            for evaluator in record.required_evidence or ():
                if evaluator.artifact is not None:
                    require(
                        evaluator.artifact,
                        kind="artifact",
                        label=f"Computation {record.id} Evidence evaluator artifact",
                    )
                overlay = getattr(evaluator.source, "overlay", None)
                if overlay is not None:
                    require(
                        overlay,
                        kind="artifact_set",
                        label=f"Computation {record.id} Evidence evaluator Git source overlay",
                    )
            continue
        if record.kind != "execution":
            continue
        require(record.computation, kind="computation", label=f"Execution {record.id} computation")
        for port, references in record.inputs.items():
            for reference in references:
                input_digest = require(
                    reference,
                    kind=("artifact", "artifact_set"),
                    label=f"Execution {record.id} input {port!r}",
                )
                derivation.setdefault(input_digest, set()).add(record_id)
        for port, references in (record.outputs or {}).items():
            for reference in references:
                output_digest = require(
                    reference,
                    kind=("artifact", "artifact_set"),
                    label=f"Execution {record.id} output {port!r}",
                )
                derivation.setdefault(record_id, set()).add(output_digest)
        parent = record.parent_execution
        if parent is None:
            continue
        parent_id = require(
            parent,
            kind="execution",
            label=f"Execution {record.id} parent_execution",
        )
        orchestration.setdefault(parent_id, set()).add(record_id)

    _raise_on_cycle(derivation, label="derivation")
    _raise_on_cycle(orchestration, label="orchestration")


def _raise_on_cycle(adjacency: dict[str, set[str]], *, label: str) -> None:
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node: str) -> None:
        if node in visiting:
            raise ValueError(f"{label} graph contains a cycle")
        if node in visited:
            return
        visiting.add(node)
        for neighbor in adjacency.get(node, ()):
            visit(neighbor)
        visiting.remove(node)
        visited.add(node)

    for node in adjacency:
        visit(node)


def _record_paths(root: Path) -> Iterable[Path]:
    for kind in RECORD_KINDS:
        yield from sorted((root / kind).glob("*/*.json"))


def _node(
    record_id: str,
    record: Any,
    *,
    record_digest: str,
    execution_states: dict[str, _InvocationExecutionSummary],
) -> dict[str, Any]:
    node = {
        "id": record_id,
        "kind": record.kind,
        "record_id": record.id,
        "label": _node_label(record),
        # Canonical JSON hash is catalog integrity metadata only. Graph
        # identity and Core references use the UUID in ``id``.
        "record_digest": f"sha256:{record_digest}",
    }
    if record.kind == "execution":
        # Execution records remain immutable. Its status is a read-only
        # CYCLOPS projection from the terminal lifecycle Event.
        node["status"] = execution_states[record_id].status
    elif record.kind == "event":
        node["timeline_at"] = _timestamp(record.occurred_at)
        node["timeline_sequence"] = str(record.sequence)
        if record.status is not None:
            node["status"] = record.status
    elif record.kind == "evidence":
        node["timeline_at"] = _timestamp(record.observed_at)
        # Evidence outcome is Core-owned data that CYCLOPS may use for a
        # compact status treatment. It is not a presentation inference.
        node["outcome"] = record.outcome
    elif record.kind == "artifact":
        # Media type is a Core Artifact field. Carry it separately from the
        # label so clients can choose a semantic icon without parsing display
        # text or guessing from a filename.
        node["media_type"] = record.media_type
        if record.created_at is not None:
            node["timeline_at"] = _timestamp(record.created_at)
    elif record.kind == "artifact_set" and record.created_at is not None:
        node["timeline_at"] = _timestamp(record.created_at)
    return node


def _evidence_sequence_tiebreakers(
    records: dict[str, Any],
    reference_edges: Iterable[dict[str, str]],
) -> dict[str, str]:
    """Place same-time Evidence just after an Event that directly names it."""

    tiebreakers: dict[str, str] = {}
    for edge in reference_edges:
        if edge["relation"] != "event-reference":
            continue
        event = records[edge["source"]]
        evidence = records[edge["target"]]
        if event.kind != "event" or evidence.kind != "evidence":
            continue
        if _timestamp(event.occurred_at) != _timestamp(evidence.observed_at):
            continue
        # A direct Event reference establishes a causal tie without inventing
        # a visible dataflow edge. Place Evidence after the Event when their
        # immutable timestamps are equal.
        sequence = float(event.sequence) + 0.5
        current = tiebreakers.get(edge["target"])
        if current is None or sequence > float(current):
            tiebreakers[edge["target"]] = f"{sequence:g}"
    return tiebreakers


def _invocation_summaries(records: dict[str, Any]) -> dict[str, _InvocationSummary]:
    """Resolve portable profile timelines or generic event-time fallbacks."""

    events_by_invocation = _events_by_invocation(records)

    summaries: dict[str, _InvocationSummary] = {}
    for digest, record in records.items():
        if record.kind != "execution":
            continue
        computation_id = _reference_id(record.computation)
        computation = records.get(computation_id) if computation_id else None
        locator = record.computation.id
        if computation is not None and computation.kind == "computation":
            locator = computation.implementation.locator
        summaries[digest] = _InvocationSummary(
            locator=locator,
            display_name=record.name or _display_locator(locator),
            timeline=_invocation_timeline(record, events_by_invocation.get(digest, [])),
            legacy=record.outputs is None,
        )
    return summaries


def _invocation_execution_summaries(
    records: dict[str, Any],
    invocation_summaries: dict[str, _InvocationSummary],
) -> dict[str, _InvocationExecutionSummary]:
    """Project terminal Event status and diagnostics onto each Invocation.

    The result is CYCLOPS navigation metadata.  Invocation records remain
    immutable and intentionally do not grow an implementation-specific status
    field.
    """

    events_by_invocation = _events_by_invocation(records)

    summaries: dict[str, _InvocationExecutionSummary] = {}
    for digest, record in records.items():
        if record.kind != "execution":
            continue
        # ``execution-terminal`` is the current core lifecycle Event emitted
        # by the SDK for every observed Execution. A shared lifecycle profile
        # groups a batch or workflow; it must not determine whether an
        # otherwise complete request-scoped Execution is terminal. Retain the
        # older event spellings solely for already-recorded legacy data.
        terminal_types = {
            "execution-terminal",
            "execution-completed",
            "execution-failed",
        }
        terminal_events = [
            event
            for event in events_by_invocation.get(digest, [])
            if event.event_type in terminal_types
        ]
        if not terminal_events:
            summaries[digest] = _InvocationExecutionSummary(
                status="incomplete",
                diagnostic=None,
            )
            continue
        terminal_event = max(
            terminal_events,
            key=lambda event: (
                event.occurred_at,
                event.sequence,
                _record_key(records, event),
            ),
        )
        event_status = getattr(terminal_event, "status", None)
        event_diagnostic = getattr(terminal_event, "diagnostic", None)
        status = (
            event_status
            if event_status is not None
            else "failed"
            if terminal_event.event_type == "execution-failed"
            else "succeeded"
        )
        summaries[digest] = _InvocationExecutionSummary(
            status=status,
            diagnostic=(
                event_diagnostic.model_dump(mode="json", exclude_none=True)
                if event_diagnostic is not None
                else None
            ),
        )
    return summaries


def _display_locator(locator: str) -> str:
    """Use a concise callable name without assuming a language or runtime."""

    return locator.rsplit(".", maxsplit=1)[-1]


def _events_by_invocation(records: dict[str, Any]) -> dict[str, list[Any]]:
    events_by_invocation: dict[str, list[Any]] = {}
    for record in records.values():
        if record.kind != "event":
            continue
        execution_id = _invocation_reference_id(record.execution, records)
        if execution_id is not None:
            events_by_invocation.setdefault(execution_id, []).append(record)
    return events_by_invocation


def _record_key(records: dict[str, Any], target: Any) -> str:
    """Return a record UUID for deterministic ties."""

    return next(record_id for record_id, record in records.items() if record is target)


def _invocation_timeline(record: Any, events: list[Any]) -> _InvocationTimeline:
    binding = (record.profiles or {}).get(RUN_PROFILE)
    if binding is not None:
        try:
            timeline = run_timeline(binding, events)
        except (ValidationError, ValueError):
            pass
        else:
            return _InvocationTimeline(
                kind="run",
                started_at=timeline.started_at,
                completed_at=timeline.completed_at,
                first_event_at=min((event.occurred_at for event in events), default=None),
                last_event_at=max((event.occurred_at for event in events), default=None),
            )
    if not events:
        return _InvocationTimeline(kind="none")
    return _InvocationTimeline(
        kind="generic",
        first_event_at=min(event.occurred_at for event in events),
        last_event_at=max(event.occurred_at for event in events),
    )


def _timestamp(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _display_record_id(identifier: str) -> str:
    """Abbreviate a legacy record ID without presenting it as a new value."""

    if len(identifier) <= 32:
        return identifier
    return f"{identifier[:8]}…{identifier[-20:]}"


def _node_label(record: Any) -> str:
    """Use only Core-owned record fields in a uniform graph-node label."""

    if record.kind == "event":
        # An Event's ID is an opaque immutable record identifier. Its Core
        # event_type is the concise, semantically useful canvas label.
        return f"event\n{record.event_type}"
    display_value = record.name or _display_record_id(record.id)
    kind_label = record.media_type if record.kind == "artifact" else record.kind
    return f"{kind_label}\n{display_value}"


def _computation_label(display_names: list[str], execution_count: int) -> str:
    count_label = "execution" if execution_count == 1 else "executions"
    if len(display_names) == 1:
        return f"{display_names[0]} · {execution_count} {count_label}"
    return f"{execution_count} {count_label}"


def _run_label(display_name: str, run_identifier: str) -> str:
    """Describe a legacy root Execution without treating its UUID as a name."""

    return f"{display_name} · {run_identifier}"


def _profile_run_label(run_id: str) -> str:
    """Give a profile run a concise fallback label from its app-owned ID."""

    return run_id.rsplit(":", maxsplit=1)[-1]


def _aggregate_run_timeline(
    timelines: Iterable[_InvocationTimeline],
) -> _InvocationTimeline:
    """Summarize chronology from real members without inventing a root event."""

    values = tuple(timelines)
    if not values:
        return _InvocationTimeline(kind="none")
    started_at = [value.started_at for value in values if value.started_at is not None]
    completed_at = [
        value.completed_at for value in values if value.completed_at is not None
    ]
    first_event_at = [
        value.first_event_at for value in values if value.first_event_at is not None
    ]
    last_event_at = [
        value.last_event_at for value in values if value.last_event_at is not None
    ]
    return _InvocationTimeline(
        kind="run" if all(value.kind == "run" for value in values) else "generic",
        started_at=min(started_at, default=None),
        completed_at=max(completed_at, default=None),
        first_event_at=min(first_event_at, default=None),
        last_event_at=max(last_event_at, default=None),
    )


def _compact_label(value: str, *, maximum: int = 34) -> str:
    """Use a short identifier for a long resource label in the graph."""

    if len(value) <= maximum:
        return value
    leaf = value.rsplit("/", maxsplit=1)[-1]
    identifier = leaf.split(".", maxsplit=1)[0]
    return identifier[:8]


def _artifact_kind_from_location(location: str) -> str:
    """Use an explicit filename suffix when an Artifact has no profile."""

    tail = _display_location(location).rsplit("/", maxsplit=1)[-1]
    suffix = tail.rsplit(".", maxsplit=1)[-1] if "." in tail else ""
    return suffix or "artifact"


def _display_location(location: str) -> str:
    """Keep the useful tail of a URI without assuming a storage provider."""

    path = unquote(urlparse(location).path).rstrip("/")
    components = [component for component in path.split("/") if component]
    if not components:
        return location
    return "/".join(components[-2:])


def _label_derivation_artifacts(
    nodes: tuple[dict[str, str], ...],
    derivation_edges: tuple[dict[str, str], ...],
) -> tuple[dict[str, str], ...]:
    """Preserve record-owned labels; port roles remain edge metadata."""

    del derivation_edges
    return nodes


def _mark_dataset_snapshot_nodes(
    nodes: tuple[dict[str, str], ...],
    collection_edges: tuple[dict[str, str], ...],
) -> tuple[dict[str, str], ...]:
    """Mark profile manifests that have validated partition membership."""

    snapshot_ids = {
        edge["source"] for edge in collection_edges if edge["relation"] == "dataset-partition"
    }
    return tuple(
        {
            **node,
            **({"collection_kind": "dataset-snapshot"} if node["id"] in snapshot_ids else {}),
        }
        for node in nodes
    )


def _reference_edges(records: dict[str, Any]) -> Iterable[dict[str, str]]:
    seen: set[tuple[str, str, str]] = set()

    def emit(source: str, reference: RecordReference, relation: str) -> None:
        if reference.id not in records:
            return
        edge = (source, reference.id, relation)
        if edge not in seen:
            seen.add(edge)
            yieldable.append(
                {
                    "id": f"{source}:{relation}:{reference.id}",
                    "source": source,
                    "target": reference.id,
                    "relation": relation,
                }
            )

    yieldable: list[dict[str, str]] = []
    for digest, record in records.items():
        if record.kind == "artifact":
            binding_data = (record.profiles or {}).get(RELEASE_MANIFEST_PROFILE)
            if binding_data is not None:
                try:
                    binding = ReleaseManifestBinding.model_validate(binding_data)
                except ValidationError:
                    binding = None
                if (
                    binding is not None
                    and binding.artifact_set.id in records
                    and records[binding.artifact_set.id].kind == "artifact_set"
                ):
                    emit(digest, binding.artifact_set, "release-manifest")
        elif record.kind == "artifact_set":
            for member in record.members:
                emit(digest, member.artifact, "contains")
        elif record.kind == "computation":
            if record.implementation.artifact is not None:
                emit(digest, record.implementation.artifact, "implementation")
        elif record.kind == "execution":
            emit(digest, record.computation, "computation")
            if record.parent_execution is not None:
                parent_id = _invocation_reference_id(record.parent_execution, records)
                if parent_id is not None:
                    yieldable.append(
                        {
                            "id": f"{parent_id}:orchestrates:{digest}",
                            "source": parent_id,
                            "target": digest,
                            "relation": "orchestrates",
                        }
                    )
            for references in record.inputs.values():
                for reference in references:
                    emit(digest, reference, "input")
            for references in (record.outputs or {}).values():
                for reference in references:
                    emit(digest, reference, "output")
        elif record.kind == "evidence":
            emit(digest, record.subject, "evidence-subject")
        elif record.kind == "event":
            emit(digest, record.execution, "event-execution")
            for reference in _references_in_json(record.data):
                emit(digest, reference, "event-reference")
    return sorted(yieldable, key=lambda edge: (edge["relation"], edge["id"]))


def _invocation_reference_id(
    reference: RecordReference,
    records: dict[str, Any],
) -> str | None:
    target = records.get(reference.id)
    return reference.id if target is not None and target.kind == "execution" else None


def _derivation_edges(records: dict[str, Any]) -> Iterable[dict[str, str]]:
    edges: list[dict[str, str]] = []
    for invocation_digest, record in records.items():
        if record.kind != "execution":
            continue
        for port, references in record.inputs.items():
            for reference in references:
                _append_derivation_edge(
                    edges,
                    records,
                    source=reference,
                    target=invocation_digest,
                    relation="consumes",
                    label=f"input: {port}",
                )
        for port, references in (record.outputs or {}).items():
            for reference in references:
                _append_derivation_edge(
                    edges,
                    records,
                    source=invocation_digest,
                    target=reference,
                    relation="produces",
                    label=f"output: {port}",
                )
    return sorted(edges, key=lambda edge: (edge["relation"], edge["id"]))


def _collection_edges(root: Path, records: dict[str, Any]) -> Iterable[dict[str, str]]:
    """Return generic set and dataset-profile membership overlays."""

    edges: list[dict[str, str]] = []
    for artifact_set_id, record in records.items():
        if record.kind != "artifact_set":
            continue
        for member in record.members:
            artifact_id = member.artifact.id
            if artifact_id not in records:
                continue
            edges.append(
                {
                    "id": f"{artifact_set_id}:contains:{artifact_id}",
                    "source": artifact_set_id,
                    "target": artifact_id,
                    "relation": "contains",
                    "label": member.role or member.name,
                }
            )
    for snapshot_id, record in records.items():
        if record.kind != "artifact" or DATASET_SNAPSHOT_PROFILE not in (record.profiles or {}):
            continue
        manifest = _load_dataset_snapshot_manifest(root, record)
        if manifest is None:
            continue
        for partition in manifest.partitions:
            artifact_id = partition.artifact.id
            target = records.get(artifact_id)
            if target is None or target.kind != "artifact":
                continue
            edges.append(
                {
                    "id": f"{snapshot_id}:dataset-partition:{artifact_id}",
                    "source": snapshot_id,
                    "target": artifact_id,
                    "relation": "dataset-partition",
                    "label": partition.name,
                }
            )
    return sorted(edges, key=lambda edge: edge["id"])


def _load_dataset_snapshot_manifest(
    root: Path,
    record: Any,
) -> DatasetSnapshotManifest | None:
    """Load and integrity-check an in-store dataset-snapshot payload.

    CYCLOPS is a local project explorer, so it reads only payloads stored under
    the configured OCLP root. It does not dereference arbitrary Artifact
    locations or pretend an unavailable remote payload has known membership.
    """

    payload_dir = root / "payload" / record.digest.value[:2]
    for path in sorted(payload_dir.glob(record.digest.value + ".*")):
        content = path.read_bytes()
        if hashlib.sha256(content).hexdigest() != record.digest.value:
            continue
        try:
            return DatasetSnapshotManifest.model_validate_json(content)
        except ValidationError:
            continue
    return None


def _append_derivation_edge(
    edges: list[dict[str, str]],
    records: dict[str, Any],
    *,
    source: str | RecordReference,
    target: str | RecordReference,
    relation: str,
    label: str,
) -> None:
    source_id = _reference_id(source)
    target_id = _reference_id(target)
    if source_id is None or target_id is None:
        return
    if source_id not in records or target_id not in records:
        return
    edges.append(
        {
            "id": f"{source_id}:{relation}:{target_id}",
            "source": source_id,
            "target": target_id,
            "relation": relation,
            "label": label,
        }
    )


def _reference_id(value: str | RecordReference) -> str | None:
    if isinstance(value, str):
        return value
    return value.id


def _references_in_json(value: Any) -> Iterable[RecordReference]:
    if isinstance(value, dict):
        if set(value) == {"id"}:
            try:
                yield RecordReference.model_validate(value)
            except ValueError:
                pass
        for nested in value.values():
            yield from _references_in_json(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from _references_in_json(nested)
