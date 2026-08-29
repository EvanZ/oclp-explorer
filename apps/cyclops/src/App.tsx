import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BaseEdge,
  Controls,
  getBezierPath,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useInternalNode,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
  type NodeProps,
  type ReactFlowInstance,
  type XYPosition,
} from "@xyflow/react";
import { toCanvas } from "html-to-image";
import { GIFEncoder, applyPalette, quantize } from "gifenc";
import {
  Cog,
  Database,
  File,
  FileInput,
  FileOutput,
  FileStack,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  ScrollText,
  ShieldCheck,
  Zap,
  type LucideIcon,
} from "lucide-react";

import type {
  Diagnostic,
  GraphEdge,
  GraphNode,
  GraphPayload,
  RecordPayload,
  Run,
  RunInvocation,
  RunLineage,
  RunsPayload,
  Summary,
} from "./types";

type ThemeName = "dark" | "light";
type RunStatusFilter = "all" | "needs_attention" | "failed" | "succeeded";
type FilteredRun = {
  run: Run;
  invocations: RunInvocation[];
  matchingInvocationCount: number;
};
type FilteredLineage = {
  lineage: RunLineage;
  runs: FilteredRun[];
  matchingInvocationCount: number;
};
type GraphTheme = {
  canvasBackground: string;
  grid: string;
  minimap: string;
  minimapMask: string;
  nodeBackground: string;
  nodeText: string;
  selection: string;
  referenceEdge: string;
  trace: {
    upstream: string;
    downstream: string;
  };
  kinds: Record<string, string>;
};

const GRAPH_THEMES: Record<ThemeName, GraphTheme> = {
  dark: {
    canvasBackground: "#0c1218",
    grid: "#314152",
    minimap: "#101b25",
    minimapMask: "rgba(12, 18, 24, 0.68)",
    nodeBackground: "#16212c",
    nodeText: "#e5edf5",
    selection: "#b9f3ff",
    referenceEdge: "#718096",
    trace: {
      upstream: "#60a5fa",
      downstream: "#34d399",
    },
    kinds: {
      artifact: "#6ee7b7",
      artifact_set: "#fbbf24",
      definition: "#93c5fd",
      invocation: "#c4b5fd",
      evidence: "#fb7185",
      event: "#67e8f9",
    },
  },
  light: {
    canvasBackground: "#f4f7fb",
    grid: "#cbd5e1",
    minimap: "#eef3f8",
    minimapMask: "rgba(241, 245, 249, 0.7)",
    nodeBackground: "#ffffff",
    nodeText: "#17202b",
    selection: "#0e7490",
    referenceEdge: "#64748b",
    trace: {
      upstream: "#2563eb",
      downstream: "#059669",
    },
    kinds: {
      artifact: "#057a55",
      artifact_set: "#a16207",
      definition: "#2563eb",
      invocation: "#7c3aed",
      evidence: "#be123c",
      event: "#0891b2",
    },
  },
};

const RUN_STATUS_FILTERS: Array<{ id: RunStatusFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "needs_attention", label: "Needs attention" },
  { id: "failed", label: "Failed" },
  { id: "succeeded", label: "Succeeded" },
];
const GIF_FRAME_COUNT = 15;
const GIF_FRAME_DELAY_MS = 180;
const GIF_MAX_WIDTH = 1280;
const TIMELINE_AXIS_LEFT = 120;
const TIMELINE_UNTIMED_INPUT_OFFSET = 260;
const TIMELINE_MIN_WIDTH = 920;
const TIMELINE_MAX_WIDTH = 3_200;
const TIMELINE_VERTICAL_DRAG_BOUND = 1_000_000;
const GRAPH_LAYOUT_VERSION = "causal-output-events-v1";
const TIMELINE_TICK_STEPS_MS = [
  1_000,
  5_000,
  10_000,
  30_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
  24 * 60 * 60_000,
  2 * 24 * 60 * 60_000,
  7 * 24 * 60 * 60_000,
  14 * 24 * 60 * 60_000,
  30 * 24 * 60 * 60_000,
];

type TimelineTickData = {
  label: string;
  height: number;
};
type RecordNodeData = {
  label: string;
  kind: string;
  collectionKind?: "dataset-snapshot";
  artifactRole?: "input" | "output" | "intermediate";
};
type NodePositionsByScope = Record<string, Record<string, XYPosition>>;
type BaseGraphView = "run" | "derivation" | "timeline";

function TimelineTick({ data }: NodeProps) {
  const tick = data as TimelineTickData;
  return (
    <div className="timeline-tick" style={{ height: tick.height }}>
      <span>{tick.label}</span>
    </div>
  );
}

function recordIcon(data: RecordNodeData): LucideIcon {
  if (data.collectionKind === "dataset-snapshot") return Database;
  switch (data.kind) {
    case "artifact":
      return data.artifactRole === "input"
        ? FileInput
        : data.artifactRole === "output"
          ? FileOutput
          : File;
    case "artifact_set":
      return FileStack;
    case "definition":
      return ScrollText;
    case "invocation":
      return Cog;
    case "event":
      return Zap;
    case "evidence":
      return ShieldCheck;
    default:
      return File;
  }
}

function RecordNode({ data }: NodeProps) {
  const record = data as RecordNodeData;
  const Icon = recordIcon(record);
  return (
    <div className="record-node">
      <Icon
        aria-hidden="true"
        className={
          "record-node-icon" +
          (record.kind === "invocation"
            ? " is-rotating"
            : record.kind === "event"
              ? " is-pulsing"
              : record.kind === "artifact_set"
                ? " is-compressing"
              : "")
        }
        size={30}
        strokeWidth={2}
      />
      <span className="record-node-label">
        {record.label.split("\n").map((line, index) => (
          <span key={index}>{line}</span>
        ))}
      </span>
      <Handle className="record-node-handle" type="target" position={Position.Left} />
      <Handle className="record-node-handle" type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { record: RecordNode, timelineTick: TimelineTick };

type NodeBounds = {
  height: number;
  width: number;
  x: number;
  y: number;
};

function internalNodeBounds(node: ReturnType<typeof useInternalNode>): NodeBounds | null {
  if (!node) return null;
  const width = node.measured.width ?? node.width ?? 0;
  const height = node.measured.height ?? node.height ?? 0;
  if (width <= 0 || height <= 0) return null;
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    width,
    height,
  };
}

function nearestSide(from: NodeBounds, to: NodeBounds): Position {
  const horizontalDistance = to.x + to.width / 2 - (from.x + from.width / 2);
  const verticalDistance = to.y + to.height / 2 - (from.y + from.height / 2);
  if (Math.abs(horizontalDistance) >= Math.abs(verticalDistance)) {
    return horizontalDistance >= 0 ? Position.Right : Position.Left;
  }
  return verticalDistance >= 0 ? Position.Bottom : Position.Top;
}

function sidePoint(bounds: NodeBounds, side: Position): XYPosition {
  switch (side) {
    case Position.Left:
      return { x: bounds.x, y: bounds.y + bounds.height / 2 };
    case Position.Right:
      return { x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2 };
    case Position.Top:
      return { x: bounds.x + bounds.width / 2, y: bounds.y };
    case Position.Bottom:
      return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height };
  }
}

function FloatingEdge({ id, source, target, markerEnd, style }: EdgeProps) {
  const sourceBounds = internalNodeBounds(useInternalNode(source));
  const targetBounds = internalNodeBounds(useInternalNode(target));
  if (!sourceBounds || !targetBounds) return null;
  const sourcePosition = nearestSide(sourceBounds, targetBounds);
  const targetPosition = nearestSide(targetBounds, sourceBounds);
  const sourcePoint = sidePoint(sourceBounds, sourcePosition);
  const targetPoint = sidePoint(targetBounds, targetPosition);
  const [path] = getBezierPath({
    sourcePosition,
    sourceX: sourcePoint.x,
    sourceY: sourcePoint.y,
    targetPosition,
    targetX: targetPoint.x,
    targetY: targetPoint.y,
  });
  return <BaseEdge id={id} markerEnd={markerEnd} path={path} style={style} />;
}

const edgeTypes = { floating: FloatingEdge };

function waitForAnimationFrame(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

function gifFilename(graph: GraphPayload | null): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return "cyclops-" + (graph?.view ?? "graph") + "-flow-" + timestamp + ".gif";
}

function timelineTimestamp(node: GraphNode): number | null {
  const value = node.timeline_at ? Date.parse(node.timeline_at) : Number.NaN;
  return Number.isNaN(value) ? null : value;
}

function timelineNodeTimestampLabel(node: GraphNode): string | null {
  const timestamp = timelineTimestamp(node);
  if (timestamp === null) return null;
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(timestamp));
}

function timelineSequence(node: GraphNode): number {
  const value = node.timeline_sequence ? Number(node.timeline_sequence) : Number.NaN;
  return Number.isNaN(value) ? Number.POSITIVE_INFINITY : value;
}

function timelineTrackKind(node: GraphNode): string {
  if (node.timeline_role === "input") return "input";
  if (node.timeline_role === "output") return "output";
  return node.kind === "artifact" || node.kind === "artifact_set" ? "output" : node.kind;
}

function definitionInvocationAnchors(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Map<string, GraphNode> {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const anchors = new Map<string, GraphNode>();
  for (const edge of edges) {
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    const definition = source?.kind === "definition"
      ? source
      : target?.kind === "definition"
        ? target
        : undefined;
    const invocation = source?.kind === "invocation"
      ? source
      : target?.kind === "invocation"
        ? target
        : undefined;
    if (!definition || !invocation) continue;
    const current = anchors.get(definition.id);
    const candidateTime = timelineTimestamp(invocation) ?? Number.POSITIVE_INFINITY;
    const currentTime = current ? timelineTimestamp(current) ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY;
    if (
      !current ||
      candidateTime < currentTime ||
      (candidateTime === currentTime && invocation.id.localeCompare(current.id) < 0)
    ) {
      anchors.set(definition.id, invocation);
    }
  }
  return anchors;
}

function eventInvocationAnchors(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Map<string, GraphNode> {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const anchors = new Map<string, GraphNode>();
  for (const edge of edges) {
    if (edge.relation !== "event-invocation") continue;
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    const event = source?.kind === "event"
      ? source
      : target?.kind === "event"
        ? target
        : undefined;
    const invocation = source?.kind === "invocation"
      ? source
      : target?.kind === "invocation"
        ? target
        : undefined;
    if (event && invocation) anchors.set(event.id, invocation);
  }
  return anchors;
}

function timelineTickStep(span: number): number {
  const target = Math.max(1_000, span / 8);
  return TIMELINE_TICK_STEPS_MS.find((step) => step >= target) ?? TIMELINE_TICK_STEPS_MS.at(-1)!;
}

function timelineTickLabel(value: number, step: number): string {
  const date = new Date(value);
  const dateText = new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
    year: step >= 24 * 60 * 60_000 ? "numeric" : undefined,
  }).format(date);
  const timeText = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: step < 60_000 ? "2-digit" : undefined,
    hour12: false,
    timeZone: "UTC",
  }).format(date);
  return step >= 24 * 60 * 60_000 ? dateText + " UTC" : dateText + " · " + timeText + " UTC";
}

type GifFlowPulse = {
  color: string;
  lineWidth: number;
  path: Path2D;
};
type GifNodeRect = {
  height: number;
  width: number;
  x: number;
  y: number;
};

function gifFlowPulses(graphPanel: HTMLDivElement, scale: number): GifFlowPulse[] {
  const bounds = graphPanel.getBoundingClientRect();
  return [...graphPanel.querySelectorAll<SVGPathElement>(
    ".react-flow__edge.animated .react-flow__edge-path",
  )].flatMap((edge) => {
    const matrix = edge.getScreenCTM();
    const length = edge.getTotalLength();
    if (!matrix || length <= 0) return [];

    const path = new Path2D();
    const step = 8;
    for (let distance = 0; distance <= length; distance += step) {
      const point = edge.getPointAtLength(Math.min(distance, length));
      const screenPoint = new DOMPoint(point.x, point.y).matrixTransform(matrix);
      const x = (screenPoint.x - bounds.left) * scale;
      const y = (screenPoint.y - bounds.top) * scale;
      if (distance === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    }

    const style = window.getComputedStyle(edge);
    return [{
      color: style.stroke,
      lineWidth: Number.parseFloat(style.strokeWidth) || 1,
      path,
    }];
  });
}

function drawGifFlowPulses(
  context: CanvasRenderingContext2D,
  pulses: GifFlowPulse[],
  frame: number,
  scale: number,
): void {
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const pulse of pulses) {
    context.setLineDash([11 * scale, 13 * scale]);
    context.lineDashOffset = -frame * 9 * scale;
    context.lineWidth = Math.max(1.6, pulse.lineWidth * scale + 0.6);
    context.strokeStyle = pulse.color;
    context.shadowBlur = 3 * scale;
    context.shadowColor = pulse.color;
    context.stroke(pulse.path);
  }
  context.restore();
}

function gifNodeRects(
  graphPanel: HTMLDivElement,
  scale: number,
  canvasWidth: number,
  canvasHeight: number,
): GifNodeRect[] {
  const panelBounds = graphPanel.getBoundingClientRect();
  const inset = Math.ceil(4 * scale);
  return [...graphPanel.querySelectorAll<HTMLElement>(
    ".react-flow__node:not(.react-flow__node-timelineTick)",
  )]
    .map((node) => {
      const bounds = node.getBoundingClientRect();
      const x = Math.max(0, Math.floor((bounds.left - panelBounds.left) * scale) - inset);
      const y = Math.max(0, Math.floor((bounds.top - panelBounds.top) * scale) - inset);
      const right = Math.min(
        canvasWidth,
        Math.ceil((bounds.right - panelBounds.left) * scale) + inset,
      );
      const bottom = Math.min(
        canvasHeight,
        Math.ceil((bounds.bottom - panelBounds.top) * scale) + inset,
      );
      return { x, y, width: right - x, height: bottom - y };
    })
    .filter((rect) => rect.width > 0 && rect.height > 0)
    // Restore containers before their members so a parent can never cover a
    // member Artifact when the animated pulse passes underneath the group.
    .sort((left, right) => right.width * right.height - left.width * left.height);
}

function restoreGifNodeLayers(
  context: CanvasRenderingContext2D,
  baseImage: ImageData,
  nodeRects: GifNodeRect[],
): void {
  for (const rect of nodeRects) {
    context.putImageData(baseImage, 0, 0, rect.x, rect.y, rect.width, rect.height);
  }
}

function statusLabel(status: string | undefined): string {
  const value = status || "incomplete";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function statusSummary(statusCounts: Record<string, number> | undefined): string {
  const counts = statusCounts ?? {};
  const order = ["failed", "incomplete", "succeeded", "skipped"];
  return order
    .filter((status) => counts[status])
    .map((status) => `${counts[status]} ${status}`)
    .join(" · ") || "status unavailable";
}

function timelineSummary(run: Run): string | null {
  if (run.timeline.kind === "lifecycle" && run.timeline.requested_at) {
    return "requested " + new Date(run.timeline.requested_at).toLocaleString();
  }
  if (run.timeline.first_event_at) {
    return "first event " + new Date(run.timeline.first_event_at).toLocaleString();
  }
  return null;
}

function diagnosticText(diagnostic: Diagnostic | null): string {
  if (!diagnostic) return "";
  return [diagnostic.stage, diagnostic.code, diagnostic.message]
    .filter((value): value is string => Boolean(value))
    .join(" — ");
}

function invocationMatchesStatus(
  invocation: RunInvocation,
  statusFilter: RunStatusFilter,
): boolean {
  if (statusFilter === "all") return true;
  if (statusFilter === "needs_attention") {
    return invocation.status === "failed" || invocation.status === "incomplete";
  }
  return invocation.status === statusFilter;
}

function invocationMatchesQuery(invocation: RunInvocation, query: string): boolean {
  return [
    invocation.label,
    invocation.record_id,
    invocation.status,
    invocation.diagnostic?.stage ?? "",
    invocation.diagnostic?.code ?? "",
    invocation.diagnostic?.message ?? "",
  ]
    .join(" ")
    .toLocaleLowerCase()
    .includes(query);
}

type ArtifactCollectionGrouping = {
  memberNodesBySet: Map<string, GraphNode[]>;
  parentSetByArtifact: Map<string, string>;
  containedEdgeIds: Set<string>;
};

type CollectionPresentation = {
  memberCounts: Map<string, number>;
  expandedIds: Set<string>;
};

function isArtifactCollection(node: GraphNode | undefined): boolean {
  return node?.kind === "artifact_set" || node?.collection_kind === "dataset-snapshot";
}

function collectionGrouping(
  nodes: GraphNode[],
  collectionEdges: GraphEdge[],
): ArtifactCollectionGrouping {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const candidateSetsByArtifact = new Map<string, Set<string>>();
  const candidateArtifactsBySet = new Map<string, Set<string>>();

  for (const edge of collectionEdges) {
    const artifactSet = nodeById.get(edge.source);
    const artifact = nodeById.get(edge.target);
    if (
      !artifactSet ||
      !isArtifactCollection(artifactSet) ||
      artifact?.kind !== "artifact"
    ) {
      continue;
    }
    const artifactSets = candidateSetsByArtifact.get(artifact.id) ?? new Set<string>();
    artifactSets.add(artifactSet.id);
    candidateSetsByArtifact.set(artifact.id, artifactSets);
    const artifacts = candidateArtifactsBySet.get(artifactSet.id) ?? new Set<string>();
    artifacts.add(artifact.id);
    candidateArtifactsBySet.set(artifactSet.id, artifacts);
  }

  const memberNodesBySet = new Map<string, GraphNode[]>();
  const parentSetByArtifact = new Map<string, string>();
  const containedEdgeIds = new Set<string>();
  for (const artifactSet of nodes.filter(isArtifactCollection)) {
    const artifactIds = candidateArtifactsBySet.get(artifactSet.id);
    if (!artifactIds?.size) continue;
    // React Flow permits one parent per node. A shared Artifact remains outside
    // every box with its explicit membership arrows; unshared members still
    // form the natural visual group for each ArtifactSet.
    const members = nodes.filter(
      (node) =>
        artifactIds.has(node.id) && candidateSetsByArtifact.get(node.id)?.size === 1,
    );
    if (!members.length) continue;
    memberNodesBySet.set(artifactSet.id, members);
    for (const member of members) {
      parentSetByArtifact.set(member.id, artifactSet.id);
      const membership = collectionEdges.find(
        (edge) => edge.source === artifactSet.id && edge.target === member.id,
      );
      if (membership) containedEdgeIds.add(membership.id);
    }
  }
  return { memberNodesBySet, parentSetByArtifact, containedEdgeIds };
}

function collapsedCollectionMemberIds(
  graph: GraphPayload | null,
  expandedCollections: Set<string>,
): Set<string> {
  if (!graph) return new Set();
  const allNodes = new Map(
    [...graph.nodes, ...graph.collection_nodes].map((node) => [node.id, node]),
  );
  const directNodeIds = new Set(graph.nodes.map((node) => node.id));
  const collectionsByMember = new Map<string, Set<string>>();

  for (const edge of graph.collection_edges) {
    const collection = allNodes.get(edge.source);
    const member = allNodes.get(edge.target);
    if (!collection || !isArtifactCollection(collection) || member?.kind !== "artifact") {
      continue;
    }
    const collections = collectionsByMember.get(member.id) ?? new Set<string>();
    collections.add(collection.id);
    collectionsByMember.set(member.id, collections);
  }

  const collapsedMembers = new Set<string>();
  for (const [memberId, collections] of collectionsByMember) {
    const collectionId = collections.values().next().value;
    if (
      directNodeIds.has(memberId) &&
      collections.size === 1 &&
      collectionId !== undefined &&
      !expandedCollections.has(collectionId)
    ) {
      collapsedMembers.add(memberId);
    }
  }
  return collapsedMembers;
}

function collectionMemberCounts(graph: GraphPayload | null): Map<string, number> {
  if (!graph) return new Map();
  const allNodes = new Map(
    [...graph.nodes, ...graph.collection_nodes].map((node) => [node.id, node]),
  );
  const counts = new Map<string, number>();
  for (const edge of graph.collection_edges) {
    const collection = allNodes.get(edge.source);
    const member = allNodes.get(edge.target);
    if (!collection || !isArtifactCollection(collection) || member?.kind !== "artifact") {
      continue;
    }
    counts.set(collection.id, (counts.get(collection.id) ?? 0) + 1);
  }
  return counts;
}

function mergeProvenanceOverlay(
  graph: GraphPayload | null,
  provenance: GraphPayload | null,
): GraphPayload | null {
  if (!graph || !provenance) return graph;
  // The provenance endpoint includes the selected Invocation's focused Data
  // DAG so it can stand alone. When it is an overlay, that data is already
  // owned by the active primary view. Timeline now renders its direct inputs
  // itself (at their asserted time or in its explicit untimed column), so
  // adding overlay bindings would still make the Provenance switch change the
  // base Data DAG.
  const provenanceNodes = provenance.nodes.filter((node) => node.layer === "provenance");
  const provenanceEdges = provenance.edges.filter(
    (edge) => edge.relation !== "consumes" && edge.relation !== "produces",
  );
  const nodes = [...graph.nodes, ...provenanceNodes];
  const nodeIds = new Set([
    ...nodes.map((node) => node.id),
    ...graph.collection_nodes.map((node) => node.id),
  ]);
  const uniqueEdges = (edges: GraphEdge[]) =>
    [...new Map(edges.map((edge) => [edge.id, edge])).values()].filter(
      (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
    );
  return {
    ...graph,
    nodes,
    edges: uniqueEdges([...graph.edges, ...provenanceEdges]),
    // Collection membership is contextual data navigation, not provenance.
    // Keep the primary view's collection projection unchanged as well.
    collection_edges: graph.collection_edges,
  };
}

function provenanceTimelineOrder(left: GraphNode, right: GraphNode): number {
  const timestampDelta =
    (timelineTimestamp(left) ?? Number.POSITIVE_INFINITY) -
    (timelineTimestamp(right) ?? Number.POSITIVE_INFINITY);
  if (timestampDelta !== 0) return timestampDelta;
  const sequenceDelta = timelineSequence(left) - timelineSequence(right);
  if (sequenceDelta !== 0) return sequenceDelta;
  return left.record_id.localeCompare(right.record_id);
}

function flowNodes(
  graph: GraphPayload | null,
  nodes: GraphNode[],
  theme: GraphTheme,
  selectedNodeId: string | null,
  artifactSets: ArtifactCollectionGrouping,
  collectionPresentation: CollectionPresentation,
): Node[] {
  const columnWidth = 310;
  const visibleNodeIds = new Set(nodes.map((node) => node.id));
  const artifactBindingRoles = new Map<string, Set<"input" | "output">>();
  for (const edge of graph?.edges ?? []) {
    if (!visibleNodeIds.has(edge.source) || !visibleNodeIds.has(edge.target)) continue;
    if (edge.relation === "consumes") {
      const roles = artifactBindingRoles.get(edge.source) ?? new Set<"input" | "output">();
      roles.add("input");
      artifactBindingRoles.set(edge.source, roles);
    } else if (edge.relation === "produces") {
      const roles = artifactBindingRoles.get(edge.target) ?? new Set<"input" | "output">();
      roles.add("output");
      artifactBindingRoles.set(edge.target, roles);
    }
  }
  const artifactRoleFor = (node: GraphNode): RecordNodeData["artifactRole"] => {
    if (node.kind !== "artifact") return undefined;
    const roles = artifactBindingRoles.get(node.id);
    if (!roles || roles.size !== 1) return roles?.size ? "intermediate" : undefined;
    return roles.has("input") ? "input" : "output";
  };
  const derivationLevels = new Map(nodes.map((node) => [node.id, 0]));
  const usesDataLayout =
    graph?.view === "run" ||
    graph?.view === "derivation" ||
    graph?.view === "provenance";
  if (usesDataLayout) {
    for (let pass = 0; pass < nodes.length; pass += 1) {
      for (const edge of graph.edges) {
        if (
          edge.relation !== "consumes" &&
          edge.relation !== "produces" &&
          !(graph.view === "run" && edge.relation === "orchestrates")
        ) continue;
        derivationLevels.set(
          edge.target,
          Math.max(
            derivationLevels.get(edge.target) ?? 0,
            (derivationLevels.get(edge.source) ?? 0) + 1,
          ),
        );
      }
    }
  }
  const eventAnchors = eventInvocationAnchors(nodes, graph?.edges ?? []);
  const eventOutputIndex = new Map<string, number>();
  const eventsByInvocation = new Map<string, GraphNode[]>();
  for (const event of nodes.filter((node) => node.kind === "event")) {
    const invocation = eventAnchors.get(event.id);
    if (!invocation) continue;
    const events = eventsByInvocation.get(invocation.id) ?? [];
    events.push(event);
    eventsByInvocation.set(invocation.id, events);
  }
  for (const events of eventsByInvocation.values()) {
    events.sort(provenanceTimelineOrder).forEach((event, index) => {
      eventOutputIndex.set(event.id, index);
    });
  }
  const groupedSetNodes = nodes.filter((node) => artifactSets.memberNodesBySet.has(node.id));
  const groupedSetIds = new Set(groupedSetNodes.map((node) => node.id));
  const memberNodeIds = new Set(artifactSets.parentSetByArtifact.keys());
  const dataColumnFor = (node: GraphNode) =>
    node.kind === "artifact_set" || node.collection_kind === "dataset-snapshot"
      ? derivationLevels.get(node.id) ?? -1
      : derivationLevels.get(node.id) ?? 0;
  // Mirror the primary data-node placement order so an Event can sit beside
  // its owning Invocation even when it is emitted much later in record order.
  const dataRowByNode = new Map<string, number>();
  const nextDataRowByColumn = new Map<number, number>();
  const topLevelDataNodes = [
    ...groupedSetNodes,
    ...nodes.filter((node) => !groupedSetIds.has(node.id) && !memberNodeIds.has(node.id)),
  ];
  for (const node of topLevelDataNodes) {
    if (node.layer === "provenance") continue;
    const column = dataColumnFor(node);
    const row = nextDataRowByColumn.get(column) ?? 0;
    const slots = artifactSets.memberNodesBySet.has(node.id)
      ? Math.max(
          1,
          Math.ceil((58 + (artifactSets.memberNodesBySet.get(node.id)?.length ?? 0) * 70) / 140),
        )
      : 1;
    dataRowByNode.set(node.id, row);
    nextDataRowByColumn.set(column, row + slots);
  }
  const byKind = new Map<string, number>();
  const byLevel = new Map<number, number>();
  const provenanceByKind = new Map<string, number>();
  const provenanceTimeline = nodes
    .filter(
      (node) =>
        node.layer === "provenance" &&
        (node.kind === "event" || node.kind === "evidence"),
    )
    .sort(provenanceTimelineOrder);
  const provenanceTimelineIndex = new Map(
    provenanceTimeline.map((node, index) => [node.id, index]),
  );

  const positionFor = (node: GraphNode, slots = 1) => {
    const isSelected = node.id === selectedNodeId;
    const isProvenance = node.layer === "provenance";
    const eventAnchor = node.kind === "event" ? eventAnchors.get(node.id) : undefined;
    const index = byKind.get(node.kind) ?? 0;
    byKind.set(node.kind, index + 1);
    const provenanceColumn = eventAnchor
      ? dataColumnFor(eventAnchor) + 1
      : node.kind === "artifact" || node.kind === "artifact_set"
        ? -1
        : 1;
    const column = usesDataLayout
      ? isProvenance
        ? provenanceColumn
        : dataColumnFor(node)
      : Object.keys(theme.kinds).indexOf(node.kind);
    const provenanceIndex = provenanceByKind.get(node.kind) ?? 0;
    if (isProvenance) provenanceByKind.set(node.kind, provenanceIndex + 1);
    const dataLevelIndex = byLevel.get(column) ?? 0;
    if (!isProvenance) byLevel.set(column, dataLevelIndex + slots);
    const levelIndex = isProvenance
      ? eventAnchor
        ? (dataRowByNode.get(eventAnchor.id) ?? 0) +
          0.55 +
          (eventOutputIndex.get(node.id) ?? 0) * 0.6
        : node.kind === "definition" ||
        node.kind === "artifact" ||
        node.kind === "artifact_set"
        ? -1 - provenanceIndex
        : node.kind === "event" || node.kind === "evidence"
          ? 1 + (provenanceTimelineIndex.get(node.id) ?? 0)
          : 1 + provenanceTimeline.length + provenanceIndex
      : dataLevelIndex;

    return {
      isSelected,
      position: {
        x: column * columnWidth,
        y: (usesDataLayout ? levelIndex : index) * 140,
      },
    };
  };

  const renderNode = (
    node: GraphNode,
    position: { x: number; y: number },
    options: { parentId?: string; collection?: boolean } = {},
  ): Node => {
    const isSelected = node.id === selectedNodeId;
    const isArtifact = node.kind === "artifact";
    const isInvocation = node.kind === "invocation";
    const isProvenance = node.layer === "provenance";
    const isCollection = options.collection === true;
    const isCollectionNode = isArtifactCollection(node);
    const timelineTimestampLabelText =
      graph?.view === "timeline" ? timelineNodeTimestampLabel(node) : null;
    const displayLabel = [node.label, timelineTimestampLabelText]
      .filter((value): value is string => Boolean(value))
      .join("\n");
    const memberCount = collectionPresentation.memberCounts.get(node.id) ?? 0;
    const isCollapsedCollection =
      isCollectionNode && memberCount > 0 && !collectionPresentation.expandedIds.has(node.id);
    const collectionColor =
      node.collection_kind === "dataset-snapshot"
        ? theme.kinds.artifact
        : theme.kinds.artifact_set;
    const collectionStack = isCollapsedCollection
      ? [
          "4px 4px 0 color-mix(in srgb, " + collectionColor + " 42%, " + theme.nodeBackground + ")",
          "8px 8px 0 color-mix(in srgb, " + collectionColor + " 24%, " + theme.nodeBackground + ")",
        ]
      : [];
    const selectionGlow = isSelected
      ? "0 0 0 2px color-mix(in srgb, " + theme.selection + " 55%, transparent)"
      : null;
    return {
      id: node.id,
      type: "record",
      parentId: options.parentId,
      extent: options.parentId
        ? "parent"
        : graph?.view === "timeline"
          ? [
              [position.x, -TIMELINE_VERTICAL_DRAG_BOUND],
              [position.x, TIMELINE_VERTICAL_DRAG_BOUND],
            ]
          : undefined,
      position,
      data: {
        label: isCollapsedCollection
          ? displayLabel + "\n▸ " + memberCount + (memberCount === 1 ? " member" : " members")
          : displayLabel,
        kind: node.kind,
        collectionKind: node.collection_kind,
        artifactRole: artifactRoleFor(node),
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      style: {
        background: isCollection
          ? "color-mix(in srgb, " + collectionColor + " 12%, " + theme.nodeBackground + ")"
          : theme.nodeBackground,
        border:
          isSelected
            ? "2px solid " + theme.selection
            : (isProvenance ? "1px dashed " : "1px solid ") +
              (theme.kinds[node.kind] ?? theme.referenceEdge),
        boxShadow: [selectionGlow, ...collectionStack].filter(Boolean).join(", ") || undefined,
        borderRadius: isCollection ? 14 : isArtifact ? 999 : isInvocation ? 0 : 10,
        clipPath: isInvocation
          ? "polygon(12% 0, 88% 0, 100% 50%, 88% 100%, 12% 100%, 0 50%)"
          : undefined,
        color: theme.nodeText,
        fontSize: isCollectionNode ? 11 : 12,
        fontWeight: isCollectionNode ? 700 : undefined,
        lineHeight: 1.35,
        padding: isCollectionNode
          ? "9px 12px"
          : isInvocation
            ? "12px 34px"
            : isArtifact
              ? "8px 16px"
              : 10,
        width: isCollectionNode ? 225 : isInvocation ? 240 : isArtifact ? 185 : 215,
        height: isCollection
          ? 58 + (artifactSets.memberNodesBySet.get(node.id)?.length ?? 0) * 70
          : undefined,
        whiteSpace: "pre-line",
        overflowWrap: "anywhere",
        wordBreak: "break-word",
        opacity: isProvenance ? 0.82 : 1,
        filter: isSelected
          ? "drop-shadow(0 0 8px " + theme.selection + ")"
          : undefined,
        // A selected collection must remain behind its member nodes. Otherwise
        // React Flow raises the parent box above them, intercepting clicks and
        // visually obscuring the very Artifacts the box is meant to organize.
        zIndex: options.parentId ? 2 : isCollection ? 0 : isSelected ? 2 : undefined,
      },
    };
  };

  if (graph?.view === "timeline") {
    const timedNodes = nodes
      .map((node) => ({ node, timestamp: timelineTimestamp(node) }))
      .filter((entry): entry is { node: GraphNode; timestamp: number } => entry.timestamp !== null)
      .sort((left, right) => provenanceTimelineOrder(left.node, right.node));
    const earliest = timedNodes.at(0)?.timestamp ?? Date.now();
    const latest = timedNodes.at(-1)?.timestamp ?? earliest;
    const tickStep = timelineTickStep(Math.max(1_000, latest - earliest));
    const axisStart = Math.floor((earliest - tickStep) / tickStep) * tickStep;
    const axisEnd = Math.ceil((latest + tickStep) / tickStep) * tickStep;
    const axisSpan = Math.max(tickStep, axisEnd - axisStart);
    const axisWidth = Math.min(
      TIMELINE_MAX_WIDTH,
      Math.max(TIMELINE_MIN_WIDTH, (axisSpan / tickStep) * 160),
    );
    const untimedInputX = TIMELINE_AXIS_LEFT - TIMELINE_UNTIMED_INPUT_OFFSET;
    const hasUntimedInputs = nodes.some(
      (node) => node.timeline_role === "input" && timelineTimestamp(node) === null,
    );
    const definitionAnchors = definitionInvocationAnchors(nodes, graph.edges);
    const xFor = (node: GraphNode) => {
      if (node.timeline_role === "input" && timelineTimestamp(node) === null) {
        return untimedInputX;
      }
      const anchor = node.kind === "definition" ? definitionAnchors.get(node.id) : undefined;
      const timestamp = timelineTimestamp(anchor ?? node) ?? axisStart;
      return TIMELINE_AXIS_LEFT + ((timestamp - axisStart) / axisSpan) * axisWidth;
    };
    const invocationLanes = nodes
      .filter((node) => node.kind === "invocation")
      .sort((left, right) => {
        const depth = Number(left.timeline_depth ?? 0) - Number(right.timeline_depth ?? 0);
        return depth || provenanceTimelineOrder(left, right);
      });
    const laneIndex = new Map(invocationLanes.map((node, index) => [node.id, index]));
    const unassignedLane = invocationLanes.length;
    const placements = [...nodes]
      .sort(provenanceTimelineOrder)
      .map((node) => ({
        node,
        x: xFor(node),
        lane: laneIndex.get(
          node.timeline_lane ??
            (node.kind === "definition" ? definitionAnchors.get(node.id)?.id : undefined) ??
            node.id,
        ) ?? unassignedLane,
      }));
    const trackEnds = new Map<string, number[]>();
    const trackCounts = new Map<string, number>();
    const placementTracks = new Map<string, number>();
    for (const placement of placements) {
      const trackKey = placement.lane + ":" + timelineTrackKind(placement.node);
      const nodeWidth = placement.node.kind === "invocation" ? 260 : 240;
      const tracks = trackEnds.get(trackKey) ?? [];
      let track = tracks.findIndex((lastX) => lastX <= placement.x - nodeWidth - 24);
      if (track === -1) {
        track = tracks.length;
        tracks.push(placement.x + nodeWidth);
      } else {
        tracks[track] = placement.x + nodeWidth;
      }
      trackEnds.set(trackKey, tracks);
      trackCounts.set(trackKey, tracks.length);
      placementTracks.set(placement.node.id, track);
    }
    const hasUnassignedLane = placements.some((placement) => placement.lane === unassignedLane);
    const laneCount = invocationLanes.length + (hasUnassignedLane ? 1 : 0);
    const laneStarts = new Map<number, number>();
    let nextLaneY = 0;
    for (let lane = 0; lane < laneCount; lane += 1) {
      laneStarts.set(lane, nextLaneY);
      const definitionTracks = trackCounts.get(lane + ":definition") ?? 0;
      const inputTracks = trackCounts.get(lane + ":input") ?? 0;
      const eventTracks = trackCounts.get(lane + ":event") ?? 0;
      const evidenceTracks = trackCounts.get(lane + ":evidence") ?? 0;
      const outputTracks = trackCounts.get(lane + ":output") ?? 0;
      const invocationTracks = trackCounts.get(lane + ":invocation") ?? 0;
      nextLaneY += Math.max(
        205,
        64 +
          invocationTracks * 74 +
          definitionTracks * 74 +
          inputTracks * 74 +
          eventTracks * 74 +
          evidenceTracks * 74 +
          outputTracks * 74,
      );
    }
    const timelineNodes = placements.map(({ node, x, lane }) => {
      const laneY = laneStarts.get(lane) ?? 0;
      const track = placementTracks.get(node.id) ?? 0;
      const definitionTracks = trackCounts.get(lane + ":definition") ?? 0;
      const inputTracks = trackCounts.get(lane + ":input") ?? 0;
      const eventTracks = trackCounts.get(lane + ":event") ?? 0;
      const evidenceTracks = trackCounts.get(lane + ":evidence") ?? 0;
      const invocationTracks = trackCounts.get(lane + ":invocation") ?? 0;
      const typeOffset =
        node.kind === "definition"
          ? 0
          : node.timeline_role === "input"
            ? definitionTracks * 74
          : node.kind === "invocation"
            ? definitionTracks * 74 + inputTracks * 74
          : node.kind === "event"
              ? 64 + invocationTracks * 74 + definitionTracks * 74 + inputTracks * 74
            : node.kind === "evidence"
                ? 64 + invocationTracks * 74 + definitionTracks * 74 + inputTracks * 74 + eventTracks * 74
                : 64 +
                    invocationTracks * 74 +
                    definitionTracks * 74 +
                    inputTracks * 74 +
                    eventTracks * 74 +
                    evidenceTracks * 74;
      return renderNode(node, { x, y: laneY + typeOffset + track * 74 });
    });
    const tickHeight = nextLaneY + 60;
    const ticks: Node[] = [];
    if (hasUntimedInputs) {
      ticks.push({
        id: "timeline-untimed-inputs",
        type: "timelineTick",
        position: { x: untimedInputX, y: -34 },
        data: { label: "Untimed inputs", height: tickHeight },
        draggable: false,
        selectable: false,
        connectable: false,
        focusable: false,
        zIndex: -1,
      });
    }
    for (let value = axisStart; value <= axisEnd; value += tickStep) {
      ticks.push({
        id: "timeline-tick:" + value,
        type: "timelineTick",
        position: {
          x: TIMELINE_AXIS_LEFT + ((value - axisStart) / axisSpan) * axisWidth,
          y: -34,
        },
        data: { label: timelineTickLabel(value, tickStep), height: tickHeight },
        draggable: false,
        selectable: false,
        connectable: false,
        focusable: false,
        zIndex: -1,
      });
    }
    return [...ticks, ...timelineNodes];
  }

  const rendered: Node[] = [];
  for (const artifactSet of groupedSetNodes) {
    const members = artifactSets.memberNodesBySet.get(artifactSet.id) ?? [];
    const { position } = positionFor(
      artifactSet,
      Math.max(1, Math.ceil((58 + members.length * 70) / 140)),
    );
    rendered.push(renderNode(artifactSet, position, { collection: true }));
    members.forEach((member, index) => {
      rendered.push(
        renderNode(member, { x: 20, y: 48 + index * 70 }, { parentId: artifactSet.id }),
      );
    });
  }
  for (const node of nodes) {
    if (
      artifactSets.memberNodesBySet.has(node.id) ||
      artifactSets.parentSetByArtifact.has(node.id)
    ) {
      continue;
    }
    const { position } = positionFor(node);
    rendered.push(renderNode(node, position));
  }
  return rendered;
}

const REVERSED_REFERENCE_FLOW_RELATIONS = new Set([
  "contains",
  "dataset-partition",
  "definition",
  "evidence-subject",
  "event-invocation",
  "event-reference",
  "implementation",
  "input",
]);

function asCausalFlowEdge(edge: GraphEdge): GraphEdge {
  if (!REVERSED_REFERENCE_FLOW_RELATIONS.has(edge.relation)) return edge;
  return { ...edge, source: edge.target, target: edge.source };
}

type DependencyTrace = {
  downstream: Set<string>;
  upstream: Set<string>;
};

function dependencyTraceEdgeIds(
  edges: GraphEdge[],
  selectedNodeId: string | null,
): DependencyTrace {
  if (!selectedNodeId) return { upstream: new Set(), downstream: new Set() };
  const prerequisites = new Map<string, Array<{ edge: GraphEdge; nodeId: string }>>();
  const dependents = new Map<string, Array<{ edge: GraphEdge; nodeId: string }>>();
  const addPrerequisite = (dependent: string, prerequisite: string, edge: GraphEdge) => {
    const prerequisiteEntries = prerequisites.get(dependent) ?? [];
    prerequisiteEntries.push({ edge, nodeId: prerequisite });
    prerequisites.set(dependent, prerequisiteEntries);
    const dependentEntries = dependents.get(prerequisite) ?? [];
    dependentEntries.push({ edge, nodeId: dependent });
    dependents.set(prerequisite, dependentEntries);
  };

  // The visible graph is normalized to causal flow: every target depends on
  // its source. That keeps arrowheads and bidirectional traversal meaningful
  // even for Core references, whose JSON ownership direction is the reverse.
  for (const edge of edges) addPrerequisite(edge.target, edge.source, edge);

  const walk = (
    adjacency: Map<string, Array<{ edge: GraphEdge; nodeId: string }>>,
  ) => {
    const edgeIds = new Set<string>();
    const visited = new Set([selectedNodeId]);
    const pending = [selectedNodeId];
    while (pending.length) {
      const nodeId = pending.pop()!;
      for (const { edge, nodeId: adjacent } of adjacency.get(nodeId) ?? []) {
        edgeIds.add(edge.id);
        if (!visited.has(adjacent)) {
          visited.add(adjacent);
          pending.push(adjacent);
        }
      }
    }
    return edgeIds;
  };

  return {
    upstream: walk(prerequisites),
    downstream: walk(dependents),
  };
}

function flowEdges(
  edges: GraphEdge[],
  theme: GraphTheme,
  containedEdgeIds: Set<string>,
  dependencyTrace: DependencyTrace,
): Edge[] {
  const hasDependencyTrace =
    dependencyTrace.upstream.size > 0 || dependencyTrace.downstream.size > 0;
  return edges
    .filter(
      (edge) =>
        (edge.relation !== "contains" && edge.relation !== "dataset-partition") ||
        !containedEdgeIds.has(edge.id),
    )
    .map((edge) => {
    const isUpstream = dependencyTrace.upstream.has(edge.id);
    const isDownstream = dependencyTrace.downstream.has(edge.id);
    const isDependencyTrace = isUpstream || isDownstream;
    const baseStroke =
      edge.relation === "produces"
        ? theme.kinds.artifact
        : edge.relation === "consumes"
          ? theme.kinds.definition
          : edge.relation === "dataset-partition"
            ? theme.kinds.artifact
            : edge.relation === "contains"
              ? theme.kinds.artifact_set
              : edge.relation === "orchestrates"
                ? theme.kinds.invocation
                : theme.referenceEdge;
    const stroke = isUpstream
      ? theme.trace.upstream
      : isDownstream
        ? theme.trace.downstream
        : baseStroke;
    return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type:
      edge.relation === "contains" || edge.relation === "dataset-partition"
        ? undefined
        : "floating",
    animated:
      (edge.relation === "consumes" || edge.relation === "produces") &&
      (!hasDependencyTrace || isDependencyTrace),
    markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
    style: {
      opacity: hasDependencyTrace && !isDependencyTrace ? 0.16 : 1,
      stroke,
      strokeDasharray:
        edge.relation === "consumes" ||
        edge.relation === "produces" ||
        edge.relation === "contains" ||
        edge.relation === "dataset-partition"
          ? undefined
          : "5 4",
      strokeWidth: isDependencyTrace ? 2.8 : undefined,
    },
    zIndex: isDependencyTrace ? 2 : 0,
    };
    });
}

export default function App() {
  const [graph, setGraph] = useState<GraphPayload | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [lineages, setLineages] = useState<RunLineage[]>([]);
  const [selectedLineage, setSelectedLineage] = useState<string>();
  const [selectedRun, setSelectedRun] = useState<string>();
  const [selectedInvocation, setSelectedInvocation] = useState<string>();
  const [expandedLineages, setExpandedLineages] = useState<Set<string>>(new Set());
  const [runFilter, setRunFilter] = useState("");
  const [runStatusFilter, setRunStatusFilter] =
    useState<RunStatusFilter>("all");
  const [selected, setSelected] = useState<RecordPayload | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [isSelectedLoading, setIsSelectedLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isExportingGif, setIsExportingGif] = useState(false);
  const [themeName, setThemeName] = useState<ThemeName>("dark");
  const [baseView, setBaseView] = useState<BaseGraphView>("run");
  const [isProvenanceVisible, setIsProvenanceVisible] = useState(false);
  const [isLineageExplorerVisible, setIsLineageExplorerVisible] = useState(true);
  const [isDetailPanelVisible, setIsDetailPanelVisible] = useState(true);
  const [provenanceGraph, setProvenanceGraph] = useState<GraphPayload | null>(null);
  const [expandedCollections, setExpandedCollections] = useState<Set<string>>(
    new Set(),
  );
  const [nodePositionsByScope, setNodePositionsByScope] =
    useState<NodePositionsByScope>({});
  const flow = useRef<ReactFlowInstance | null>(null);
  const graphPanelRef = useRef<HTMLDivElement | null>(null);
  const selectedRecordRequest = useRef<AbortController | null>(null);
  const didInitialize = useRef(false);
  const theme = GRAPH_THEMES[themeName];
  const displayGraph = useMemo(
    () => mergeProvenanceOverlay(graph, isProvenanceVisible ? provenanceGraph : null),
    [graph, isProvenanceVisible, provenanceGraph],
  );
  const graphNodeById = useMemo(
    () =>
      new Map(
        [...(displayGraph?.nodes ?? []), ...(displayGraph?.collection_nodes ?? [])].map((node) => [
          node.id,
          node,
        ]),
      ),
    [displayGraph],
  );

  const loadGraph = useCallback(async (
    view: GraphPayload["view"] = "run",
    run?: string,
    invocation?: string,
    path?: string,
  ) => {
    try {
      setError(null);
      const parameters = new URLSearchParams({ view });
      if (run) parameters.set("run", run);
      if (invocation && (view === "derivation" || view === "provenance")) {
        parameters.set("invocation", invocation);
      }
      const graphPath = path ?? "/api/graph?" + parameters.toString();
      const [graphResponse, healthResponse] = await Promise.all([
        fetch(graphPath),
        fetch("/api/health"),
      ]);
      if (!graphResponse.ok || !healthResponse.ok) {
        throw new Error("CYCLOPS could not load this OCLP store.");
      }
      setGraph((await graphResponse.json()) as GraphPayload);
      setSummary((await healthResponse.json()) as Summary);
    } catch (loadError) {
      setError((loadError as Error).message);
    }
  }, []);

  const loadProvenanceOverlay = useCallback(async (run?: string, invocation?: string) => {
    if (!invocation) {
      setProvenanceGraph(null);
      return false;
    }
    try {
      const parameters = new URLSearchParams({ view: "provenance", invocation });
      if (run) parameters.set("run", run);
      const response = await fetch("/api/graph?" + parameters.toString());
      if (!response.ok) throw new Error("CYCLOPS could not load provenance context.");
      setProvenanceGraph((await response.json()) as GraphPayload);
      return true;
    } catch (loadError) {
      setError((loadError as Error).message);
      return false;
    }
  }, []);

  const loadRuns = useCallback(async (openFirstRun = false) => {
    try {
      const response = await fetch("/api/runs");
      if (!response.ok) throw new Error("CYCLOPS could not list runs.");
      const payload = (await response.json()) as RunsPayload;
      setRuns(payload.runs);
      setLineages(payload.lineages);
      setExpandedLineages((current) => {
        const available = new Set(payload.lineages.map((lineage) => lineage.id));
        return new Set([...current].filter((lineageId) => available.has(lineageId)));
      });
      if (openFirstRun) {
        const firstLineage = payload.lineages[0];
        const first = firstLineage?.runs[0] ?? payload.runs[0];
        setSelectedLineage(firstLineage?.id);
        setSelectedRun(first?.id);
        setSelectedInvocation(first?.invocations[0]?.id);
        setExpandedLineages(firstLineage ? new Set([firstLineage.id]) : new Set());
        setBaseView("run");
        setIsProvenanceVisible(false);
        setProvenanceGraph(null);
        await loadGraph(first ? "run" : "derivation", first?.id);
      }
    } catch (loadError) {
      setError((loadError as Error).message);
    }
  }, [loadGraph]);

  const refreshProject = useCallback(async (openFirstRun = false) => {
    try {
      setError(null);
      setIsRefreshing(true);
      const response = await fetch("/api/health?refresh=true");
      if (!response.ok) throw new Error("CYCLOPS could not refresh this OCLP store.");
      setSummary((await response.json()) as Summary);
      if (openFirstRun) {
        await loadRuns(true);
      } else {
        await Promise.all([
          loadRuns(),
          loadGraph(
            baseView,
            selectedRun,
            baseView === "derivation" ? selectedInvocation : undefined,
          ),
          isProvenanceVisible
            ? loadProvenanceOverlay(selectedRun, selectedInvocation)
            : Promise.resolve(true),
        ]);
      }
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      setIsRefreshing(false);
    }
  }, [baseView, isProvenanceVisible, loadGraph, loadProvenanceOverlay, loadRuns, selectedInvocation, selectedRun]);

  useEffect(() => {
    if (didInitialize.current) return;
    didInitialize.current = true;
    void refreshProject(true);
  }, [refreshProject]);

  const visibleNodes = useMemo(() => {
    if (
      !displayGraph ||
      (displayGraph.view !== "run" && displayGraph.view !== "derivation")
    ) {
      return displayGraph?.nodes ?? [];
    }
    const collapsedMembers = collapsedCollectionMemberIds(displayGraph, expandedCollections);
    const nodes = new Map(
      displayGraph.nodes
        .filter((node) => !collapsedMembers.has(node.id))
        .map((node) => [node.id, node]),
    );
    for (const node of displayGraph.collection_nodes) {
      if (
        displayGraph.collection_edges.some(
          (edge) => edge.target === node.id && expandedCollections.has(edge.source),
        )
      ) {
        nodes.set(node.id, node);
      }
    }
    return [...nodes.values()];
  }, [displayGraph, expandedCollections]);
  const visibleEdges = useMemo(() => {
    if (!displayGraph) return [];
    if (displayGraph.view !== "run" && displayGraph.view !== "derivation") {
      return displayGraph.edges.map(asCausalFlowEdge);
    }
    const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
    return [
      ...displayGraph.edges,
      ...displayGraph.collection_edges,
    ]
      .filter(
        (edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target),
      )
      .map(asCausalFlowEdge);
  }, [displayGraph, visibleNodes]);
  const groupedCollections = useMemo(
    () => collectionGrouping(visibleNodes, displayGraph?.collection_edges ?? []),
    [displayGraph?.collection_edges, visibleNodes],
  );
  const selectedDependencyTrace = useMemo(
    () => dependencyTraceEdgeIds(visibleEdges, selectedNodeId),
    [selectedNodeId, visibleEdges],
  );
  const memberCounts = useMemo(() => collectionMemberCounts(displayGraph), [displayGraph]);
  const nodes = useMemo(
    () =>
      flowNodes(displayGraph, visibleNodes, theme, selectedNodeId, groupedCollections, {
        memberCounts,
        expandedIds: expandedCollections,
      }),
    [displayGraph, expandedCollections, groupedCollections, memberCounts, selectedNodeId, theme, visibleNodes],
  );
  const layoutScope = useMemo(
    () =>
      [
        GRAPH_LAYOUT_VERSION,
        displayGraph?.view ?? "unloaded",
        selectedRun ?? "",
        displayGraph?.view === "derivation"
          ? selectedInvocation ?? ""
          : "",
      ].join(":"),
    [displayGraph?.view, selectedInvocation, selectedRun],
  );
  const positionedNodes = useMemo(() => {
    const positions = nodePositionsByScope[layoutScope] ?? {};
    return nodes.map((node) =>
      positions[node.id] ? { ...node, position: positions[node.id] } : node,
    );
  }, [layoutScope, nodePositionsByScope, nodes]);
  const edges = useMemo(
    () =>
      flowEdges(
        visibleEdges,
        theme,
        groupedCollections.containedEdgeIds,
      selectedDependencyTrace,
      ),
    [groupedCollections, selectedDependencyTrace, theme, visibleEdges],
  );

  const updateNodePositions = useCallback((changes: NodeChange<Node>[]) => {
    const isTimeline = displayGraph?.view === "timeline";
    setNodePositionsByScope((current) => {
      const currentScope = current[layoutScope] ?? {};
      const nextScope = { ...currentScope };
      let changed = false;
      for (const change of changes) {
        if (change.type !== "position" || change.position === undefined) continue;
        const node = nodes.find((candidate) => candidate.id === change.id);
        if (!node || node.type === "timelineTick") continue;
        const position = {
          x: isTimeline ? node.position.x : change.position.x,
          y: change.position.y,
        };
        if (
          currentScope[change.id]?.x === position.x &&
          currentScope[change.id]?.y === position.y
        ) {
          continue;
        }
        nextScope[change.id] = position;
        changed = true;
      }
      return changed ? { ...current, [layoutScope]: nextScope } : current;
    });
  }, [displayGraph?.view, layoutScope, nodes]);

  useEffect(() => {
    if (!displayGraph) return;
    const animation = requestAnimationFrame(() => {
      flow.current?.fitView({ duration: 260, padding: 0.18 });
    });
    return () => cancelAnimationFrame(animation);
  // A node selection only changes local styling and the detail panel. It must
  // not refit the viewport; collection expansion intentionally does.
  }, [displayGraph, expandedCollections]);

  const clearSelectedRecord = useCallback(() => {
    selectedRecordRequest.current?.abort();
    selectedRecordRequest.current = null;
    setSelectedNodeId(null);
    setSelected(null);
    setIsSelectedLoading(false);
    setCopied(false);
  }, []);

  const selectNode: NodeMouseHandler = useCallback(async (_event, node) => {
    if (node.id === selectedNodeId) {
      clearSelectedRecord();
      return;
    }
    selectedRecordRequest.current?.abort();
    const controller = new AbortController();
    selectedRecordRequest.current = controller;
    setSelectedNodeId(node.id);
    setSelected(null);
    setIsSelectedLoading(true);
    setCopied(false);
    try {
      const response = await fetch("/api/records/" + node.id, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error("CYCLOPS could not load the selected record.");
      }
      const record = (await response.json()) as RecordPayload;
      if (selectedRecordRequest.current === controller) setSelected(record);
    } catch (loadError) {
      if ((loadError as Error).name !== "AbortError") {
        setError((loadError as Error).message);
      }
    } finally {
      if (selectedRecordRequest.current === controller) {
        selectedRecordRequest.current = null;
        setIsSelectedLoading(false);
      }
    }
  }, [clearSelectedRecord, selectedNodeId]);

  useEffect(() => {
    clearSelectedRecord();
  }, [clearSelectedRecord, graph]);

  useEffect(() => () => selectedRecordRequest.current?.abort(), []);

  const toggleCollection = useCallback((digest: string) => {
    if (!isArtifactCollection(graphNodeById.get(digest))) return;
    setExpandedCollections((current) => {
      const next = new Set(current);
      if (next.has(digest)) next.delete(digest);
      else next.add(digest);
      return next;
    });
  }, [graphNodeById]);

  const toggleSelectedCollection = useCallback(() => {
    if (selected) toggleCollection(selected.digest);
  }, [selected, toggleCollection]);

  const toggleCollectionNode: NodeMouseHandler = useCallback(
    (_event, node) => toggleCollection(node.id),
    [toggleCollection],
  );

  const selectedCollection = selected
    ? isArtifactCollection(graphNodeById.get(selected.digest))
    : false;

  const copySelectedRecord = useCallback(async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(selected.record, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_800);
    } catch {
      setError("CYCLOPS could not copy this JSON to the clipboard.");
    }
  }, [selected]);

  const exportFlowGif = useCallback(async () => {
    const graphPanel = graphPanelRef.current;
    if (!graphPanel || !graph) return;
    const originalViewport = flow.current?.getViewport();
    let viewportRestored = false;
    setError(null);
    setIsExportingGif(true);
    try {
      // Let the export class hide the on-screen controls before cloning the
      // graph panel for the still background frame.
      await waitForAnimationFrame(0);
      // Fit the selected graph scope for the export only. The user’s working
      // viewport is restored immediately after the background is captured.
      await flow.current?.fitView({ duration: 0, padding: 0.12 });
      await waitForAnimationFrame(0);
      const bounds = graphPanel.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) {
        throw new Error("CYCLOPS could not determine the visible graph size.");
      }
      const scale = Math.min(1, GIF_MAX_WIDTH / bounds.width);
      const canvasWidth = Math.max(1, Math.round(bounds.width * scale));
      const canvasHeight = Math.max(1, Math.round(bounds.height * scale));
      const gif = GIFEncoder();
      const canvas = await toCanvas(graphPanel, {
        backgroundColor: theme.canvasBackground,
        canvasHeight,
        canvasWidth,
        pixelRatio: 1,
        skipFonts: true,
      });
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("CYCLOPS could not read the graph capture.");
      const baseImage = context.getImageData(0, 0, canvas.width, canvas.height);
      const pulses = gifFlowPulses(graphPanel, scale);
      const nodeRects = gifNodeRects(graphPanel, scale, canvas.width, canvas.height);
      if (originalViewport) {
        await flow.current?.setViewport(originalViewport, { duration: 0 });
        viewportRestored = true;
      }

      for (let frame = 0; frame < GIF_FRAME_COUNT; frame += 1) {
        context.putImageData(baseImage, 0, 0);
        drawGifFlowPulses(context, pulses, frame, scale);
        restoreGifNodeLayers(context, baseImage, nodeRects);
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        const palette = quantize(image.data, 256);
        gif.writeFrame(applyPalette(image.data, palette), canvas.width, canvas.height, {
          delay: GIF_FRAME_DELAY_MS,
          palette,
          repeat: 0,
        });
        if (frame < GIF_FRAME_COUNT - 1) await waitForAnimationFrame(GIF_FRAME_DELAY_MS);
      }

      gif.finish();
      // Copy into a browser-owned ArrayBuffer so Blob never receives a
      // potentially shared backing buffer from the encoder.
      const encoded = gif.bytes();
      const payload = new Uint8Array(encoded.length);
      payload.set(encoded);
      const blob = new Blob([payload.buffer], { type: "image/gif" });
      const href = URL.createObjectURL(blob);
      const download = document.createElement("a");
      download.href = href;
      download.download = gifFilename(displayGraph);
      download.click();
      window.setTimeout(() => URL.revokeObjectURL(href), 0);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? "CYCLOPS could not export this graph: " + caught.message
          : "CYCLOPS could not export this graph.",
      );
    } finally {
      if (originalViewport && !viewportRestored) {
        void flow.current?.setViewport(originalViewport, { duration: 0 });
      }
      setIsExportingGif(false);
    }
  }, [displayGraph, graph, theme.canvasBackground]);

  const showBaseView = useCallback((view: BaseGraphView) => {
    setBaseView(view);
    void loadGraph(
      view,
      selectedRun,
      view === "derivation" ? selectedInvocation : undefined,
    );
  }, [loadGraph, selectedInvocation, selectedRun]);

  const toggleProvenance = useCallback(() => {
    if (isProvenanceVisible) {
      setIsProvenanceVisible(false);
      setProvenanceGraph(null);
      return;
    }
    if (!selectedInvocation) {
      setError("Select an Invocation before showing its provenance context.");
      return;
    }
    setIsProvenanceVisible(true);
    void loadProvenanceOverlay(selectedRun, selectedInvocation).then((loaded) => {
      if (!loaded) setIsProvenanceVisible(false);
    });
  }, [isProvenanceVisible, loadProvenanceOverlay, selectedInvocation, selectedRun]);

  useEffect(() => {
    setCopied(false);
  }, [selected?.digest]);

  const showLineage = useCallback(() => {
    if (selected) {
      const view = graph?.view ?? "run";
      const parameters = new URLSearchParams({ depth: "3", view });
      if (selectedRun) parameters.set("run", selectedRun);
      if (selectedInvocation && view !== "run") {
        parameters.set("invocation", selectedInvocation);
      }
      void loadGraph(
        view,
        selectedRun,
        selectedInvocation,
        "/api/lineage/" + selected.digest + "?" + parameters.toString(),
      );
    }
  }, [graph?.view, loadGraph, selected, selectedInvocation, selectedRun]);

  const selectLineage = useCallback((lineageId: string) => {
    const lineage = lineages.find((candidate) => candidate.id === lineageId);
    const run = lineage?.runs[0];
    clearSelectedRecord();
    setSelectedLineage(lineageId || undefined);
    setSelectedRun(run?.id);
    setSelectedInvocation(run?.invocations[0]?.id);
    setExpandedLineages((current) => new Set([...current, lineageId]));
    setExpandedCollections(new Set());
    setBaseView("run");
    void loadGraph("run", run?.id);
    if (isProvenanceVisible) {
      void loadProvenanceOverlay(run?.id, run?.invocations[0]?.id);
    }
  }, [clearSelectedRecord, isProvenanceVisible, lineages, loadGraph, loadProvenanceOverlay]);

  const selectRun = useCallback((lineageId: string, runId: string) => {
    const selected = runId || undefined;
    const run = runs.find((candidate) => candidate.id === selected);
    clearSelectedRecord();
    setSelectedLineage(lineageId || undefined);
    setSelectedRun(selected);
    setSelectedInvocation(run?.invocations[0]?.id);
    setExpandedLineages((current) => new Set([...current, lineageId]));
    setExpandedCollections(new Set());
    setBaseView("run");
    void loadGraph("run", selected);
    if (isProvenanceVisible) {
      void loadProvenanceOverlay(selected, run?.invocations[0]?.id);
    }
  }, [clearSelectedRecord, isProvenanceVisible, loadGraph, loadProvenanceOverlay, runs]);

  const selectInvocation = useCallback((lineageId: string, runId: string, invocationId: string) => {
    clearSelectedRecord();
    setSelectedLineage(lineageId || undefined);
    setSelectedRun(runId);
    setSelectedInvocation(invocationId || undefined);
    setExpandedLineages((current) => new Set([...current, lineageId]));
    setExpandedCollections(new Set());
    const view = baseView === "timeline" ? "timeline" : "derivation";
    if (view === "derivation") setBaseView("derivation");
    void loadGraph(view, runId, invocationId || undefined);
    if (isProvenanceVisible) {
      void loadProvenanceOverlay(runId, invocationId || undefined);
    }
  }, [baseView, clearSelectedRecord, isProvenanceVisible, loadGraph, loadProvenanceOverlay]);

  const toggleLineage = useCallback((lineageId: string) => {
    setExpandedLineages((current) => {
      const next = new Set(current);
      if (next.has(lineageId)) next.delete(lineageId);
      else next.add(lineageId);
      return next;
    });
  }, []);

  const filteredLineages = useMemo<FilteredLineage[]>(() => {
    const query = runFilter.trim().toLocaleLowerCase();
    return lineages.flatMap((lineage) => {
      const lineageMatchesQuery = [lineage.label, lineage.id]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query);
      const matchingRuns = lineage.runs.flatMap((run) => {
        const runMatchesQuery = [run.label, run.record_id]
          .join(" ")
          .toLocaleLowerCase()
          .includes(query);
        const hasNestedWork = run.invocations.some((invocation) => invocation.depth > 0);
        const matchingInvocations = run.invocations.filter(
          (invocation) =>
            invocationMatchesStatus(invocation, runStatusFilter) &&
            (!query || lineageMatchesQuery || runMatchesQuery || invocationMatchesQuery(invocation, query)),
        );
        const matchingWork = hasNestedWork
          ? matchingInvocations.filter((invocation) => invocation.depth > 0)
          : matchingInvocations;
        if (matchingWork.length === 0) return [];

        const visibleInvocationIds = new Set(matchingWork.map((invocation) => invocation.id));
        if (hasNestedWork) {
          for (const invocation of run.invocations) {
            if (invocation.depth === 0) visibleInvocationIds.add(invocation.id);
          }
        }
        return [{
          run,
          invocations: run.invocations.filter((invocation) => visibleInvocationIds.has(invocation.id)),
          matchingInvocationCount: matchingWork.length,
        }];
      });
      if (matchingRuns.length === 0) return [];
      return [{
        lineage,
        runs: matchingRuns,
        matchingInvocationCount: matchingRuns.reduce(
          (count, run) => count + run.matchingInvocationCount,
          0,
        ),
      }];
    });
  }, [lineages, runFilter, runStatusFilter]);
  const hasRunFilter = Boolean(runFilter.trim()) || runStatusFilter !== "all";
  const matchingInvocationCount = useMemo(
    () => filteredLineages.reduce((count, lineage) => count + lineage.matchingInvocationCount, 0),
    [filteredLineages],
  );

  useEffect(() => {
    if (!hasRunFilter) return;
    setExpandedLineages((current) => {
      const next = new Set(current);
      let changed = false;
      for (const { lineage } of filteredLineages) {
        if (!next.has(lineage.id)) {
          next.add(lineage.id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [filteredLineages, hasRunFilter]);

  return (
    <main className={"app-shell theme-" + themeName}>
      <header>
        <div>
          <p className="eyebrow">OCLP Project Explorer</p>
          <h1>CYCLOPS</h1>
        </div>
        <div className="project-summary">
          <strong>{summary?.record_count ?? "—"} records</strong>
          <span>{summary?.derivation_edge_count ?? "—"} DAG bindings</span>
          {summary?.legacy_invocation_count ? (
            <span>{summary.legacy_invocation_count} legacy invocation(s)</span>
          ) : null}
          <div className="view-controls">
            <button
              aria-label={
                themeName === "dark" ? "Switch to light mode" : "Switch to dark mode"
              }
              className="theme-toggle"
              onClick={() =>
                setThemeName((current) => (current === "dark" ? "light" : "dark"))
              }
            >
              <span aria-hidden="true">{themeName === "dark" ? "☀" : "☾"}</span>
              {themeName === "dark" ? "Light" : "Dark"}
            </button>
            <button
              aria-label="Export the current graph as an animated GIF"
              className="export-gif"
              disabled={!graph || isExportingGif}
              onClick={() => void exportFlowGif()}
              title="Export the complete current graph with animated data-flow edges"
            >
              {isExportingGif ? "Exporting…" : "Export GIF"}
            </button>
            <div className="view-toggle" role="group" aria-label="Graph view">
              <button
                aria-pressed={baseView === "run"}
                className={baseView === "run" ? "is-active" : undefined}
                onClick={() => showBaseView("run")}
              >
                Run lineage
              </button>
              <button
                aria-pressed={baseView === "derivation"}
                className={baseView === "derivation" ? "is-active" : undefined}
                onClick={() => showBaseView("derivation")}
              >
              Data DAG
              </button>
              <button
                aria-pressed={baseView === "timeline"}
                className={baseView === "timeline" ? "is-active" : undefined}
                disabled={!selectedRun}
                onClick={() => showBaseView("timeline")}
              >
                Timeline
              </button>
            </div>
            <button
              aria-checked={isProvenanceVisible}
              aria-label="Toggle provenance context"
              className={
                "provenance-switch" + (isProvenanceVisible ? " is-active" : "")
              }
              disabled={!graph || !selectedInvocation}
              onClick={toggleProvenance}
              role="switch"
              title="Show provenance context for the selected Invocation"
            >
              <span aria-hidden="true" className="provenance-switch-track">
                <span className="provenance-switch-thumb" />
              </span>
              Provenance
            </button>
          </div>
        </div>
      </header>
      {error ? <p className="error">{error}</p> : null}
      <section
        className={[
          "workspace",
          isLineageExplorerVisible ? "" : "is-lineage-explorer-hidden",
          isDetailPanelVisible ? "" : "is-detail-panel-hidden",
        ].filter(Boolean).join(" ")}
      >
        {isLineageExplorerVisible ? (
        <aside className="run-panel">
          <div className="run-panel-heading">
            <p className="eyebrow">Lineage explorer</p>
            <div className="run-panel-actions">
              <span>
                {lineages.length} lineage{lineages.length === 1 ? "" : "s"}
                {" · "}{runs.length} root run{runs.length === 1 ? "" : "s"}
              </span>
              <button
                aria-label="Refresh OCLP project"
                className="run-refresh"
                disabled={isRefreshing}
                onClick={() => void refreshProject()}
                title={
                  isRefreshing
                    ? "Refreshing OCLP project"
                    : "Refresh records and the current graph"
                }
              >
                {isRefreshing ? "…" : "↻"}
              </button>
              <button
                aria-label="Hide Lineage Explorer"
                className="run-panel-visibility-toggle"
                onClick={() => setIsLineageExplorerVisible(false)}
                title="Hide Lineage Explorer"
              >
                <PanelLeftClose aria-hidden="true" size={15} />
              </button>
            </div>
          </div>
          <input
            aria-label="Search lineages, runs, and invocations"
            onChange={(event) => setRunFilter(event.target.value)}
            placeholder="Search lineages, runs, and invocations"
            type="search"
            value={runFilter}
          />
          <div className="run-filter-controls" role="group" aria-label="Filter invocations by status">
            {RUN_STATUS_FILTERS.map((filter) => (
              <button
                aria-pressed={runStatusFilter === filter.id}
                className={runStatusFilter === filter.id ? "is-active" : undefined}
                key={filter.id}
                onClick={() => setRunStatusFilter(filter.id)}
              >
                {filter.label}
              </button>
            ))}
          </div>
          {hasRunFilter ? (
            <p className="run-filter-summary">
              {matchingInvocationCount} matching invocation{matchingInvocationCount === 1 ? "" : "s"}
              {" in "}{filteredLineages.length} lineage{filteredLineages.length === 1 ? "" : "s"}
            </p>
          ) : null}
          <div className="run-tree" role="tree" aria-label="OCLP run lineages">
            {filteredLineages.map(({ lineage, runs: lineageRuns }) => {
              const expanded = expandedLineages.has(lineage.id);
              return (
                <section className="run-tree-item" key={lineage.id}>
                  <div className="run-tree-root">
                    <button
                      aria-expanded={expanded}
                      aria-label={(expanded ? "Collapse " : "Expand ") + lineage.label}
                      className="run-tree-disclosure"
                      onClick={() => toggleLineage(lineage.id)}
                    >
                      {expanded ? "▾" : "▸"}
                    </button>
                    <button
                      aria-current={selectedLineage === lineage.id ? "true" : undefined}
                      className={
                        "run-tree-run" +
                        (selectedLineage === lineage.id && baseView === "run"
                          ? " is-active"
                          : "")
                      }
                      onClick={() => selectLineage(lineage.id)}
                      title={lineage.id}
                    >
                      <span>Lineage · {lineage.label}</span>
                      <small>
                        {lineage.root_count} root run{lineage.root_count === 1 ? "" : "s"}
                        {" · "}{statusSummary(lineage.status_counts)}
                        {" · "}{lineage.artifact_count} artifact{lineage.artifact_count === 1 ? "" : "s"}
                      </small>
                    </button>
                  </div>
                  {expanded ? (
                    <div className="lineage-tree-runs" role="group">
                      {lineageRuns.map(({ run, invocations }) => (
                        <section className="lineage-tree-run" key={run.id}>
                          <button
                            aria-current={selectedRun === run.id && baseView === "run" ? "true" : undefined}
                            className={
                              "lineage-tree-run-heading" +
                              (selectedRun === run.id && baseView === "run" ? " is-active" : "")
                            }
                            onClick={() => selectRun(lineage.id, run.id)}
                            title={run.record_id}
                          >
                            <span>Root run · {run.label}</span>
                            <small>
                              {statusSummary(run.status_counts)}
                              {" · "}{run.artifact_count} artifact{run.artifact_count === 1 ? "" : "s"}
                              {timelineSummary(run) ? " · " + timelineSummary(run) : ""}
                            </small>
                          </button>
                          <div className="run-tree-children" role="group">
                            {invocations.map((invocation) => (
                              <button
                                aria-current={selectedInvocation === invocation.id ? "true" : undefined}
                                className={
                                  "run-tree-invocation" +
                                  (selectedInvocation === invocation.id && baseView !== "run"
                                    ? " is-active"
                                    : "")
                                }
                                key={invocation.id}
                                onClick={() => selectInvocation(lineage.id, run.id, invocation.id)}
                                style={{ paddingLeft: 14 + invocation.depth * 18 }}
                                title={[
                                  invocation.record_id,
                                  diagnosticText(invocation.diagnostic),
                                ].filter(Boolean).join("\n")}
                              >
                                <span
                                  aria-hidden="true"
                                  className={
                                    invocation.depth === 0
                                      ? "run-tree-root-icon"
                                      : "run-status status-" + (invocation.status ?? "incomplete")
                                  }
                                >
                                  {invocation.depth === 0 ? "◇" : "●"}
                                </span>
                                <span className="run-tree-invocation-copy">
                                  <span>
                                    {invocation.depth === 0
                                      ? "Root invocation"
                                      : statusLabel(invocation.status)}
                                    {" · "}{invocation.label}
                                  </span>
                                  {invocation.depth > 0 &&
                                  diagnosticText(invocation.diagnostic) ? (
                                    <small>
                                      {diagnosticText(invocation.diagnostic)}
                                    </small>
                                  ) : null}
                                </span>
                              </button>
                            ))}
                          </div>
                        </section>
                      ))}
                    </div>
                  ) : null}
                </section>
              );
            })}
            {filteredLineages.length === 0 ? (
              <p className="run-tree-empty">No matching lineages.</p>
            ) : null}
          </div>
        </aside>
        ) : (
          <button
            aria-label="Show Lineage Explorer"
            className="show-run-panel"
            onClick={() => setIsLineageExplorerVisible(true)}
            title="Show Lineage Explorer"
          >
            <PanelLeftOpen aria-hidden="true" size={18} />
          </button>
        )}
        <div
          className={"graph-panel" + (isExportingGif ? " is-exporting-gif" : "")}
          ref={graphPanelRef}
        >
          <ReactFlow
            nodes={positionedNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            minZoom={0.05}
            onInit={(instance) => {
              flow.current = instance;
            }}
            onNodeClick={selectNode}
            onPaneClick={clearSelectedRecord}
            onNodeDoubleClick={toggleCollectionNode}
            onNodesChange={updateNodePositions}
            nodesConnectable={false}
            nodesDraggable
            proOptions={{ hideAttribution: true }}
          >
            <Background color={theme.grid} gap={18} />
            <Controls />
            <MiniMap
              bgColor={theme.minimap}
              maskColor={theme.minimapMask}
              nodeColor={(node) =>
                theme.kinds[(node.data as { kind?: string }).kind ?? ""] ??
                theme.referenceEdge
              }
            />
          </ReactFlow>
        </div>
        {isDetailPanelVisible ? (
        <aside className="detail-panel">
          <div className="detail-panel-heading">
            <p className="eyebrow">Selected record</p>
            <button
              aria-label="Hide Selected Record panel"
              className="detail-panel-visibility-toggle"
              onClick={() => setIsDetailPanelVisible(false)}
              title="Hide Selected Record panel"
            >
              <PanelRightClose aria-hidden="true" size={15} />
            </button>
          </div>
          {selected ? (
            <>
              <h2>{String(selected.record.kind)}</h2>
              <p className="record-id">{String(selected.record.id)}</p>
              {selectedCollection ? (
                <button onClick={toggleSelectedCollection}>
                  {expandedCollections.has(selected.digest)
                    ? "Collapse members"
                    : "Expand members"}
                </button>
              ) : null}
              <button onClick={showLineage}>Show 3-hop data lineage</button>
              <button
                aria-label="Copy selected record JSON to clipboard"
                className="copy-json"
                onClick={() => void copySelectedRecord()}
                title="Copy JSON to clipboard"
              >
                <span aria-hidden="true">{copied ? "✓" : "⧉"}</span>
                {copied ? "Copied" : "Copy JSON"}
              </button>
              <pre>{JSON.stringify(selected.record, null, 2)}</pre>
            </>
          ) : isSelectedLoading ? (
            <p>Loading selected record…</p>
          ) : (
            <p>
              Start with Run lineage to see the connected execution roots and
              their data handoffs. Use Data DAG for strict Artifact → Invocation
              → Artifact flow, Timeline for chronology, and the Provenance
              switch for selected-Invocation context. Double-click a collection
              to expand or collapse its member Artifacts.
            </p>
          )}
          {summary ? <p className="store-root">{summary.root}</p> : null}
        </aside>
        ) : (
          <button
            aria-label="Show Selected Record panel"
            className="show-detail-panel"
            onClick={() => setIsDetailPanelVisible(true)}
            title="Show Selected Record panel"
          >
            <PanelRightOpen aria-hidden="true" size={18} />
          </button>
        )}
      </section>
    </main>
  );
}
