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
    LIFECYCLE_PROFILE,
    DatasetSnapshotManifest,
    lifecycle_timeline,
)
from pydantic import ValidationError

RECORD_KINDS = (
    "artifact",
    "artifact_set",
    "definition",
    "invocation",
    "evidence",
    "event",
)


@dataclass(frozen=True)
class _InvocationSummary:
    """Human-readable identity for an Invocation node."""

    locator: str
    display_name: str
    timeline: _InvocationTimeline
    legacy: bool


@dataclass(frozen=True)
class _InvocationTimeline:
    """Portable profile chronology or an honestly labeled generic fallback."""

    kind: Literal["lifecycle", "generic", "none"]
    requested_at: datetime | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    first_event_at: datetime | None = None
    last_event_at: datetime | None = None

    @property
    def ordering_at(self) -> datetime | None:
        return self.requested_at or self.first_event_at

    def model_dump(self) -> dict[str, str | None]:
        return {
            "kind": self.kind,
            "requested_at": _timestamp(self.requested_at),
            "started_at": _timestamp(self.started_at),
            "completed_at": _timestamp(self.completed_at),
            "first_event_at": _timestamp(self.first_event_at),
            "last_event_at": _timestamp(self.last_event_at),
        }


@dataclass(frozen=True)
class _InvocationExecutionSummary:
    """CYCLOPS's read-only projection of one Invocation's terminal lifecycle."""

    status: str
    diagnostic: dict[str, object] | None


@dataclass(frozen=True)
class OclpProjectGraph:
    """An immutable, API-ready projection of one OCLP record store."""

    root: Path
    records: dict[str, Any]
    nodes: tuple[dict[str, str], ...]
    reference_edges: tuple[dict[str, str], ...]
    derivation_edges: tuple[dict[str, str], ...]
    collection_edges: tuple[dict[str, str], ...]
    invocation_summaries: dict[str, _InvocationSummary]
    invocation_executions: dict[str, _InvocationExecutionSummary]

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
            "legacy_invocation_count": sum(
                record.kind == "invocation" and record.outputs is None
                for record in self.records.values()
            ),
        }

    def computations_payload(self) -> dict[str, object]:
        """Return independently navigable connected derivation components."""

        computations = []
        for component_id, node_ids in self._components().items():
            invocations = [
                digest for digest in node_ids if self.records[digest].kind == "invocation"
            ]
            display_names = sorted(
                {self.invocation_summaries[digest].display_name for digest in invocations}
            )
            invocation_count = len(invocations)
            computations.append(
                {
                    "id": component_id,
                    "label": _computation_label(display_names, invocation_count),
                    "invocation_count": invocation_count,
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
        """Return root Invocation runs and their explicitly nested Invocations.

        A run is an explorer projection of the Core ``parent_invocation``
        hierarchy.  It deliberately is not a new OCLP record or relation: the
        root Invocation owns the run identity and its descendants are the work
        explicitly orchestrated beneath it.
        """

        runs = []
        for root_digest in self._run_roots():
            invocation_depths = self._run_invocation_depths(root_digest)
            invocation_digests = set(invocation_depths)
            data_node_ids = self._invocation_data_node_ids(invocation_digests)
            root_summary = self.invocation_summaries[root_digest]
            status_digests = {
                digest for digest, depth in invocation_depths.items() if depth > 0
            } or {root_digest}
            runs.append(
                {
                    "id": root_digest,
                    "record_id": self.records[root_digest].id,
                    "label": _run_label(
                        root_summary.display_name,
                        self._run_identifier(root_digest),
                    ),
                    "timeline": root_summary.timeline.model_dump(),
                    "invocation_count": len(invocation_digests),
                    "artifact_count": sum(
                        self.records[digest].kind == "artifact" for digest in data_node_ids
                    ),
                    "status_counts": dict(
                        sorted(
                            Counter(
                                self.invocation_executions[digest].status
                                for digest in status_digests
                            ).items()
                        )
                    ),
                    "invocations": [
                        {
                            "id": digest,
                            "record_id": self.records[digest].id,
                            "label": self.invocation_summaries[digest].display_name,
                            "depth": invocation_depths[digest],
                            "status": self.invocation_executions[digest].status,
                            "diagnostic": self.invocation_executions[digest].diagnostic,
                        }
                        for digest in sorted(
                            invocation_digests,
                            key=lambda digest: (
                                invocation_depths[digest],
                                self.invocation_summaries[digest].display_name,
                                self.records[digest].id,
                            ),
                        )
                    ],
                }
            )
        return {"runs": runs}

    def run_lineage_roots(self, root_digest: str) -> tuple[str, ...]:
        """Return every explicit run root in ``root_digest``'s lineage.

        This is an explorer projection over the existing producer/consumer
        bindings.  It lets navigation present one lineage as a group while
        preserving each root Invocation's own identity and child hierarchy.
        """

        invocation_digests = set(self._run_lineage_invocation_depths(root_digest))
        return tuple(
            root
            for root in self._run_roots()
            if root in invocation_digests
        )

    def graph_payload(
        self,
        *,
        view: str = "derivation",
        component: str | None = None,
        run: str | None = None,
        invocation: str | None = None,
    ) -> dict[str, object]:
        """Return run lineage, Data DAG, provenance context, timeline, or references."""

        nodes, edges = self._view(
            view,
            component=component,
            run=run,
            invocation=invocation,
        )
        if view not in {"derivation", "provenance", "run"}:
            return {
                "view": view,
                "nodes": list(nodes),
                "edges": list(edges),
                "collection_edges": [],
                "collection_nodes": [],
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
        }

    def record_payload(self, digest: str) -> dict[str, object]:
        """Return one stored record and its graph identity."""

        record = self.records[digest]
        return {
            "digest": digest,
            "record": record.model_dump(mode="json", exclude_none=True),
        }

    def focused_payload(
        self,
        digest: str,
        *,
        depth: int,
        view: str = "derivation",
        component: str | None = None,
        run: str | None = None,
        invocation: str | None = None,
    ) -> dict[str, object]:
        """Return the undirected lineage neighborhood around one record digest."""

        if digest not in self.records:
            raise KeyError(digest)
        nodes, edges = self._view(
            view,
            component=component,
            run=run,
            invocation=invocation,
        )
        adjacent: dict[str, set[str]] = {node["id"]: set() for node in nodes}
        if digest not in adjacent:
            return {
                "view": view,
                "nodes": [],
                "edges": [],
                "collection_edges": [],
                "collection_nodes": [],
            }
        for edge in edges:
            adjacent[edge["source"]].add(edge["target"])
            adjacent[edge["target"]].add(edge["source"])
        selected = {digest}
        frontier = deque([(digest, 0)])
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
        else:
            payload["collection_edges"] = []
            payload["collection_nodes"] = []
        return payload

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

        edges = tuple(
            edge
            for edge in self.collection_edges
            if edge["source"] in visible_node_ids
        )
        member_ids = {edge["target"] for edge in edges}
        return edges, member_ids - visible_node_ids

    def _view(
        self,
        view: str,
        *,
        component: str | None = None,
        run: str | None = None,
        invocation: str | None = None,
    ) -> tuple[tuple[dict[str, str], ...], tuple[dict[str, str], ...]]:
        if view == "run":
            return self._run_view(run)
        if view == "provenance":
            return self._provenance_view(
                component,
                run=run,
                invocation=invocation,
            )
        if view == "timeline":
            return self._timeline_view(run)
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
            derivation_node_ids.update(
                self._artifact_set_node_ids(
                    {edge["target"] for edge in derivation_edges if edge["relation"] == "produces"}
                )
            )
            return (
                tuple(node for node in self.nodes if node["id"] in derivation_node_ids),
                derivation_edges,
            )
        raise ValueError(f"Unknown graph view: {view}")

    def _timeline_view(
        self,
        run: str | None,
    ) -> tuple[tuple[dict[str, str], ...], tuple[dict[str, str], ...]]:
        """Project connected run lineage chronology onto a time axis.

        Direct inputs and outputs remain visible as Data DAG bindings. Records
        with an asserted Core ``created_at`` sit at their own time; inputs
        without that timestamp are explicitly marked untimed so the client can
        place them before the chronology without inventing a date.
        """

        root_digest = self._resolve_run(run)
        invocation_depths = self._run_lineage_invocation_depths(root_digest)
        invocation_ids = set(invocation_depths)
        evidence_sequence_tiebreakers = _evidence_sequence_tiebreakers(
            self.records,
            self.reference_edges,
        )
        timeline_owner: dict[str, str] = {}
        timeline_roles: dict[str, str] = {}
        timeline_node_ids = set(invocation_ids)
        for edge in self.reference_edges:
            if (
                edge["relation"] in {"event-invocation", "evidence-subject"}
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
            if record.kind == "invocation":
                summary = self.invocation_summaries[digest].timeline
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
    ) -> tuple[tuple[dict[str, str], ...], tuple[dict[str, str], ...]]:
        """Overlay non-dataflow Core context on the same Data DAG nodes.

        Input and output references are deliberately omitted here: their
        ``consumes`` and ``produces`` Data DAG bindings already express the
        relation.  ArtifactSet membership remains an optional navigation
        overlay, rather than a second provenance edge.
        """

        data_nodes, _ = self._view(
            "derivation",
            component=component,
            run=run,
            invocation=invocation,
        )
        data_node_ids = {node["id"] for node in data_nodes}
        context_node_ids = set(data_node_ids)
        scoped_invocations = {
            digest for digest in data_node_ids if self.records[digest].kind == "invocation"
        }
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
                    self.records[endpoint].kind == "invocation"
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
        self, run: str | None
    ) -> tuple[tuple[dict[str, str], ...], tuple[dict[str, str], ...]]:
        """Show all connected execution roots, child work, and data bindings.

        A root's explicit ``parent_invocation`` hierarchy describes the work it
        orchestrated. Artifact producer/consumer bindings can connect it to a
        previous or retry root. This run-lineage projection follows only those
        explicit data bridges, then includes the complete hierarchy for every
        connected root. It is intentionally not labeled a DAG because it also
        renders orchestration edges.
        """

        root_digest = self._resolve_run(run)
        data_node_ids = self._run_lineage_data_node_ids(root_digest)
        edges = tuple(
            edge
            for edge in (*self.derivation_edges, *self.reference_edges)
            if edge["relation"] in {"consumes", "produces", "orchestrates"}
            and edge["source"] in data_node_ids
            and edge["target"] in data_node_ids
        )
        data_node_ids.update(
            self._artifact_set_node_ids(
                {edge["target"] for edge in edges if edge["relation"] == "produces"}
            )
        )
        return (
            tuple(node for node in self.nodes if node["id"] in data_node_ids),
            tuple(sorted(edges, key=lambda edge: (edge["relation"], edge["id"]))),
        )

    def _artifact_set_node_ids(self, output_artifact_ids: set[str]) -> set[str]:
        """Return release sets bound to this computation's output scope.

        New producers bind the ArtifactSet itself as an Invocation output. That
        explicit association is required when two runs publish identical
        content-addressed member Artifacts. Older stores lack that binding, so
        their sets retain the narrower member-output fallback.
        """

        direct_output_sets = {
            digest for digest in output_artifact_ids if self.records[digest].kind == "artifact_set"
        }
        if direct_output_sets:
            return direct_output_sets

        return {
            edge["source"]
            for edge in self.collection_edges
            if edge["target"] in output_artifact_ids
            and self.records[edge["source"]].kind == "artifact_set"
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
            if invocation not in self.records or self.records[invocation].kind != "invocation":
                raise ValueError(f"Unknown invocation: {invocation}")
            if run is not None and invocation not in self._run_lineage_invocation_depths(
                self._resolve_run(run)
            ):
                raise ValueError(f"Invocation {invocation} is not part of run {run}")
            return self._invocation_data_node_ids({invocation})
        if run is not None:
            return self._run_lineage_data_node_ids(self._resolve_run(run))
        return self._component_node_ids(component)

    def _run_roots(self) -> tuple[str, ...]:
        """Return all Invocation records that are not children of another one."""

        invocation_digests = {
            digest for digest, record in self.records.items() if record.kind == "invocation"
        }
        child_digests = {
            edge["target"] for edge in self.reference_edges if edge["relation"] == "orchestrates"
        }
        return tuple(
            sorted(
                invocation_digests - child_digests,
                key=lambda digest: (
                    self.invocation_summaries[digest].timeline.ordering_at
                    or datetime.min.replace(tzinfo=UTC),
                    self.records[digest].id,
                ),
                reverse=True,
            )
        )

    def _resolve_run(self, run: str | None) -> str:
        roots = self._run_roots()
        if run is None:
            if roots:
                return roots[0]
            raise ValueError("No root Invocation runs are available")
        if run not in roots:
            raise ValueError(f"Unknown root Invocation run: {run}")
        return run

    def _run_invocation_depths(self, root_digest: str) -> dict[str, int]:
        """Return the explicit Invocation hierarchy below one root."""

        children: dict[str, list[str]] = {}
        for edge in self.reference_edges:
            if edge["relation"] == "orchestrates":
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

    def _run_data_node_ids(self, root_digest: str) -> set[str]:
        return self._invocation_data_node_ids(set(self._run_invocation_depths(root_digest)))

    def _run_lineage_data_node_ids(self, root_digest: str) -> set[str]:
        """Return direct data bindings for all Invocation roots in one lineage."""

        return self._invocation_data_node_ids(
            set(self._run_lineage_invocation_depths(root_digest))
        )

    def _run_lineage_invocation_depths(self, root_digest: str) -> dict[str, int]:
        """Return complete explicit runs connected by producer/consumer bindings.

        This deliberately does *not* treat shared, unproduced inputs as a
        connection. Crossing a run boundary requires an Artifact or
        ArtifactSet that one Invocation explicitly produced and another
        explicitly consumed. That includes retry and handoff workflows while
        avoiding a project-wide graph merely because jobs read the same lake.
        """

        root_digests = {root_digest}
        changed = True
        while changed:
            changed = False
            invocation_digests = {
                invocation_digest
                for root in root_digests
                for invocation_digest in self._run_invocation_depths(root)
            }
            produced_by_artifact: dict[str, set[str]] = {}
            consumed_by_artifact: dict[str, set[str]] = {}
            for edge in self.derivation_edges:
                if edge["relation"] == "produces":
                    produced_by_artifact.setdefault(edge["target"], set()).add(edge["source"])
                elif edge["relation"] == "consumes":
                    consumed_by_artifact.setdefault(edge["source"], set()).add(edge["target"])
            for artifact_digest, producers in produced_by_artifact.items():
                consumers = consumed_by_artifact.get(artifact_digest, set())
                bridge_invocations = (
                    producers | consumers
                    if producers & invocation_digests or consumers & invocation_digests
                    else set()
                )
                for invocation_digest in bridge_invocations:
                    root = self._run_root(invocation_digest)
                    if root not in root_digests:
                        root_digests.add(root)
                        changed = True

        depths: dict[str, int] = {}
        for root in sorted(root_digests):
            for invocation_digest, depth in self._run_invocation_depths(root).items():
                # Keep the selected root's hierarchy first in a timeline lane
                # tie; other roots retain their own hierarchy depth.
                depths[invocation_digest] = depth
        return depths

    def _run_root(self, invocation_digest: str) -> str:
        """Resolve one Invocation to its explicit orchestration root."""

        parents = {
            edge["target"]: edge["source"]
            for edge in self.reference_edges
            if edge["relation"] == "orchestrates"
        }
        root = invocation_digest
        while root in parents:
            root = parents[root]
        return root

    def _invocation_data_node_ids(self, invocation_digests: set[str]) -> set[str]:
        """Return direct input/output Artifacts for the selected Invocations."""

        node_ids = set(invocation_digests)
        for edge in self.derivation_edges:
            if edge["source"] in invocation_digests or edge["target"] in invocation_digests:
                node_ids.update((edge["source"], edge["target"]))
        return node_ids

    def _run_identifier(self, root_digest: str) -> str:
        """Prefer caller-owned run_id from the root request Event for display."""

        for record in self.records.values():
            if (
                record.kind == "event"
                and record.event_type == "invocation-requested"
                and record.invocation.digest is not None
                and record.invocation.digest.value == root_digest
                and isinstance(record.data.get("run_id"), str)
            ):
                return record.data["run_id"]
        return self.records[root_digest].id.rsplit(":", maxsplit=1)[-1]

    def _components(self) -> dict[str, set[str]]:
        adjacency: dict[str, set[str]] = {
            digest: set() for digest, record in self.records.items() if record.kind == "invocation"
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
    records = _load_records(root_path, catalog=catalog)
    if not records:
        raise ValueError(f"No OCLP records found under {root_path}")
    _validate_project_records(records)
    invocation_summaries = _invocation_summaries(records)
    invocation_executions = _invocation_execution_summaries(
        records,
        invocation_summaries,
    )
    derivation_edges = tuple(_derivation_edges(records))
    collection_edges = tuple(_collection_edges(root_path, records))
    nodes = tuple(_node(digest, record) for digest, record in sorted(records.items()))
    return OclpProjectGraph(
        root=root_path,
        records=records,
        nodes=_mark_dataset_snapshot_nodes(
            _label_derivation_artifacts(nodes, derivation_edges),
            collection_edges,
        ),
        reference_edges=tuple(_reference_edges(records)),
        derivation_edges=derivation_edges,
        collection_edges=collection_edges,
        invocation_summaries=invocation_summaries,
        invocation_executions=invocation_executions,
    )


def _load_records(
    root: Path,
    *,
    catalog: DuckdbCatalog | None,
) -> dict[str, Any]:
    records: dict[str, Any] = {}
    for path in _record_paths(root):
        record = _parse_store_record(json.loads(path.read_text()))
        digest = path.stem
        if digest in records:
            raise ValueError(f"Duplicate OCLP record digest {digest} under {root}")
        records[digest] = record
    if catalog is not None:
        # Ingest the already-parsed snapshot. Returning it rather than
        # catalog.records() retains legacy empty-profile records without
        # weakening current SDK producer validation.
        catalog.ingest(records.values())
    return records


def _parse_store_record(value: dict[str, Any]) -> Any:
    """Read a pre-null-profile local record without rewriting its identity.

    Early producer records serialized ``profiles: {}``. Current Core producers
    emit ``null`` when no profile is bound, and strict parsing rejects the
    former. CYCLOPS accepts the historical shape only at this storage-read
    boundary, then restores it on an otherwise parsed model so its original
    digest and every existing reference remain valid.
    """

    if value.get("profiles") != {}:
        return parse_record(value)
    normalized = {**value, "profiles": None}
    record = parse_record(normalized)
    fields = record.__dict__.copy()
    fields["profiles"] = {}
    return type(record).model_construct(**fields)


def _validate_project_records(records: dict[str, Any]) -> None:
    """Validate explicit bindings against the store's immutable file digests.

    Current records have a filename equal to their canonical record digest. A
    few historic records predate the mandatory ``profiles: null`` wire
    field, so recomputing their digest with the current SDK would change their
    identity. Their content-addressed filename remains the authoritative local
    identity for this explorer projection.
    """

    def require(
        reference: RecordReference,
        *,
        kind: str | tuple[str, ...],
        label: str,
    ) -> str:
        if reference.digest is None:
            raise ValueError(f"{label} must include a record digest")
        digest = reference.digest.value
        target = records.get(digest)
        if target is None:
            raise ValueError(f"{label} does not resolve in this record set")
        expected_kinds = (kind,) if isinstance(kind, str) else kind
        if target.kind not in expected_kinds:
            expected_label = " or ".join(expected_kinds)
            raise ValueError(f"{label} must resolve to a {expected_label}, got {target.kind}")
        if target.id != reference.id:
            raise ValueError(f"{label} ID does not match its resolved record")
        return digest

    derivation: dict[str, set[str]] = {}
    invocation_ids: dict[str, list[str]] = {}
    orchestration: dict[str, set[str]] = {}
    for digest, record in records.items():
        if record.kind == "invocation":
            invocation_ids.setdefault(record.id, []).append(digest)

    for digest, record in records.items():
        if record.kind == "definition":
            implementation = record.implementation
            if implementation.artifact is not None:
                require(
                    implementation.artifact,
                    kind="artifact",
                    label=f"Definition {record.id} implementation artifact",
                )
            overlay = getattr(implementation.source, "overlay", None)
            if overlay is not None:
                require(
                    overlay,
                    kind="artifact_set",
                    label=f"Definition {record.id} Git source overlay",
                )
            continue
        if record.kind != "invocation":
            continue
        require(record.definition, kind="definition", label=f"Invocation {record.id} definition")
        for port, references in record.inputs.items():
            for reference in references:
                input_digest = require(
                    reference,
                    kind=("artifact", "artifact_set"),
                    label=f"Invocation {record.id} input {port!r}",
                )
                derivation.setdefault(input_digest, set()).add(digest)
        for port, references in (record.outputs or {}).items():
            for reference in references:
                output_digest = require(
                    reference,
                    kind=("artifact", "artifact_set"),
                    label=f"Invocation {record.id} output {port!r}",
                )
                derivation.setdefault(digest, set()).add(output_digest)
        parent = record.parent_invocation
        if parent is None:
            continue
        if parent.digest is not None:
            parent_digest = require(
                parent,
                kind="invocation",
                label=f"Invocation {record.id} parent_invocation",
            )
        else:
            matches = invocation_ids.get(parent.id, [])
            if len(matches) != 1:
                raise ValueError(
                    f"Invocation {record.id} parent_invocation is ambiguous or missing"
                )
            parent_digest = matches[0]
        orchestration.setdefault(parent_digest, set()).add(digest)

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
    digest: str,
    record: Any,
) -> dict[str, str]:
    node = {
        "id": digest,
        "kind": record.kind,
        "record_id": record.id,
        "label": _node_label(record),
        "digest": f"sha256:{digest}",
    }
    if record.kind == "event":
        node["timeline_at"] = _timestamp(record.occurred_at)
        node["timeline_sequence"] = str(record.sequence)
    elif record.kind == "evidence":
        node["timeline_at"] = _timestamp(record.observed_at)
    elif record.kind in {"artifact", "artifact_set"} and record.created_at is not None:
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
        if record.kind != "invocation":
            continue
        definition_digest = _reference_digest(record.definition)
        definition = records.get(definition_digest) if definition_digest else None
        locator = record.definition.id
        if definition is not None and definition.kind == "definition":
            locator = definition.implementation.locator
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
        if record.kind != "invocation":
            continue
        timeline = invocation_summaries[digest].timeline
        terminal_types = (
            {"invocation-terminal"}
            if timeline.kind == "lifecycle"
            else {"invocation-completed", "invocation-failed"}
        )
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
            if terminal_event.event_type == "invocation-failed"
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
    invocation_ids = {
        record.id: digest for digest, record in records.items() if record.kind == "invocation"
    }
    events_by_invocation: dict[str, list[Any]] = {}
    for record in records.values():
        if record.kind != "event":
            continue
        digest = _invocation_reference_digest(record.invocation, records, invocation_ids)
        if digest is not None:
            events_by_invocation.setdefault(digest, []).append(record)
    return events_by_invocation


def _record_key(records: dict[str, Any], target: Any) -> str:
    """Return a store record's immutable filename digest for deterministic ties."""

    return next(digest for digest, record in records.items() if record is target)


def _invocation_timeline(record: Any, events: list[Any]) -> _InvocationTimeline:
    binding = (record.profiles or {}).get(LIFECYCLE_PROFILE)
    if binding is not None:
        try:
            timeline = lifecycle_timeline(binding, events)
        except (ValidationError, ValueError):
            pass
        else:
            return _InvocationTimeline(
                kind="lifecycle",
                requested_at=timeline.requested_at,
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

    display_value = record.name or _display_record_id(record.id)
    return f"{record.kind}\n{display_value}"


def _computation_label(display_names: list[str], invocation_count: int) -> str:
    count_label = "invocation" if invocation_count == 1 else "invocations"
    if len(display_names) == 1:
        return f"{display_names[0]} · {invocation_count} {count_label}"
    return f"{invocation_count} {count_label}"


def _run_label(display_name: str, run_identifier: str) -> str:
    """Describe a root Invocation without treating its digest as its identity."""

    return f"{display_name} · {run_identifier}"


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
        if reference.digest is None or reference.digest.value not in records:
            return
        edge = (source, reference.digest.value, relation)
        if edge not in seen:
            seen.add(edge)
            yieldable.append(
                {
                    "id": f"{source}:{relation}:{reference.digest.value}",
                    "source": source,
                    "target": reference.digest.value,
                    "relation": relation,
                }
            )

    yieldable: list[dict[str, str]] = []
    invocation_ids = {
        record.id: digest for digest, record in records.items() if record.kind == "invocation"
    }
    for digest, record in records.items():
        if record.kind == "artifact_set":
            for member in record.members:
                emit(digest, member.artifact, "contains")
        elif record.kind == "definition" and record.implementation.artifact is not None:
            emit(digest, record.implementation.artifact, "implementation")
        elif record.kind == "invocation":
            emit(digest, record.definition, "definition")
            if record.parent_invocation is not None:
                parent_digest = _invocation_reference_digest(
                    record.parent_invocation,
                    records,
                    invocation_ids,
                )
                if parent_digest is not None:
                    yieldable.append(
                        {
                            "id": f"{parent_digest}:orchestrates:{digest}",
                            "source": parent_digest,
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
            emit(digest, record.invocation, "event-invocation")
            for reference in _references_in_json(record.data):
                emit(digest, reference, "event-reference")
    return sorted(yieldable, key=lambda edge: (edge["relation"], edge["id"]))


def _invocation_reference_digest(
    reference: RecordReference,
    records: dict[str, Any],
    invocation_ids: dict[str, str],
) -> str | None:
    if reference.digest is not None:
        digest = reference.digest.value
        target = records.get(digest)
        return digest if target is not None and target.id == reference.id else None
    return invocation_ids.get(reference.id)


def _derivation_edges(records: dict[str, Any]) -> Iterable[dict[str, str]]:
    edges: list[dict[str, str]] = []
    for invocation_digest, record in records.items():
        if record.kind != "invocation":
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
    for artifact_set_digest, record in records.items():
        if record.kind != "artifact_set":
            continue
        for member in record.members:
            if member.artifact.digest is None:
                continue
            artifact_digest = member.artifact.digest.value
            if artifact_digest not in records:
                continue
            edges.append(
                {
                    "id": f"{artifact_set_digest}:contains:{artifact_digest}",
                    "source": artifact_set_digest,
                    "target": artifact_digest,
                    "relation": "contains",
                    "label": member.role or member.name,
                }
            )
    for snapshot_digest, record in records.items():
        if record.kind != "artifact" or DATASET_SNAPSHOT_PROFILE not in (record.profiles or {}):
            continue
        manifest = _load_dataset_snapshot_manifest(root, record)
        if manifest is None:
            continue
        for partition in manifest.partitions:
            if partition.artifact.digest is None:
                continue
            artifact_digest = partition.artifact.digest.value
            target = records.get(artifact_digest)
            if target is None or target.kind != "artifact" or target.id != partition.artifact.id:
                continue
            edges.append(
                {
                    "id": f"{snapshot_digest}:dataset-partition:{artifact_digest}",
                    "source": snapshot_digest,
                    "target": artifact_digest,
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
    source_digest = _reference_digest(source)
    target_digest = _reference_digest(target)
    if source_digest is None or target_digest is None:
        return
    if source_digest not in records or target_digest not in records:
        return
    edges.append(
        {
            "id": f"{source_digest}:{relation}:{target_digest}",
            "source": source_digest,
            "target": target_digest,
            "relation": relation,
            "label": label,
        }
    )


def _reference_digest(value: str | RecordReference) -> str | None:
    if isinstance(value, str):
        return value
    return value.digest.value if value.digest is not None else None


def _references_in_json(value: Any) -> Iterable[RecordReference]:
    if isinstance(value, dict):
        if set(value).issuperset({"id", "digest"}):
            try:
                yield RecordReference.model_validate(value)
            except ValueError:
                pass
        for nested in value.values():
            yield from _references_in_json(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from _references_in_json(nested)
