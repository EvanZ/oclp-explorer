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
import ELK from "elkjs/lib/elk.bundled.js";
import { toCanvas } from "html-to-image";
import { GIFEncoder, applyPalette, quantize } from "gifenc";
import {
  Activity,
  Binary,
  Brain,
  BrainCircuit,
  Braces,
  ChartNoAxesCombined,
  CircleX,
  Cog,
  Database,
  File,
  FileCode2,
  FileInput,
  FileJson,
  FileOutput,
  FileSpreadsheet,
  FileStack,
  FileText,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  SquareFunction,
  ShieldCheck,
  Table,
  Table2,
  Zap,
  type LucideIcon,
} from "lucide-react";

import type {
  Diagnostic,
  GraphEdge,
  GraphNode,
  GraphPayload,
  InferenceService,
  LifecycleGroup,
  RecordPayload,
  Run,
  RunExecution,
  RunLineage,
  RunsPayload,
  Summary,
} from "./types";

type ThemeName = "dark" | "light";
type RunStatusFilter = "all" | "needs_attention" | "failed" | "succeeded";
type FilteredRun = {
  run: Run;
  executions: RunExecution[];
  matchingExecutionCount: number;
};
type FilteredLineage = {
  lineage: RunLineage;
  runs: FilteredRun[];
  matchingExecutionCount: number;
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
      computation: "#93c5fd",
      execution: "#c4b5fd",
      inference_service: "#2dd4bf",
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
      computation: "#2563eb",
      execution: "#7c3aed",
      inference_service: "#0f766e",
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
// Timeline nodes are vertically packed only when their time ranges do not
// conflict. Keep their time (x) position exact, but give every visible
// record its measured presentation height plus a generous separation.
const TIMELINE_TRACK_GAP = 18;
const TIMELINE_SECTION_GAP = 26;
const TIMELINE_TRACK_KINDS = [
  "computation",
  "input",
  "execution",
  "event",
  "evidence",
  "output",
] as const;
const GRAPH_LAYOUT_VERSION = "elk-layered-causal-v6-preserve-collection-bridges";
const ELK_LAYOUT_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.spacing.nodeNode": "56",
  "elk.layered.spacing.nodeNodeBetweenLayers": "190",
  "elk.spacing.edgeNode": "36",
};
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
  outcome?: "pass" | "fail" | "error";
  status?: "succeeded" | "failed" | "skipped" | "incomplete";
  mediaType?: string;
  collectionKind?: "dataset-snapshot";
  artifactRole?: "input" | "output" | "intermediate";
};
type LifecycleGroupNodeData = {
  title?: string;
  label: string;
  recordCount: number;
};
type NodePositionsByScope = Record<string, Record<string, XYPosition>>;
type BaseGraphView = "run" | "derivation" | "timeline";

const elk = new ELK();

function TimelineTick({ data }: NodeProps) {
  const tick = data as TimelineTickData;
  return (
    <div className="timeline-tick" style={{ height: tick.height }}>
      <span>{tick.label}</span>
    </div>
  );
}

const ARTIFACT_MEDIA_TYPE_ICONS: Record<string, LucideIcon> = {
  "text/csv": FileSpreadsheet,
  "application/vnd.apache.parquet": Table2,
  "application/vnd.apache.arrow.file": Table,
  "application/json": FileJson,
  "application/x-ndjson": Braces,
  "application/yaml": FileCode2,
  "application/toml": FileCode2,
  "application/xml": FileCode2,
  "application/x-npy": Binary,
  "application/x-npz": Binary,
  "application/x-catboost-model": BrainCircuit,
  "application/x-xgboost-ubjson": ChartNoAxesCombined,
  "application/x-lightgbm-model": ChartNoAxesCombined,
  "application/x-skops": Brain,
  "application/octet-stream": Binary,
  "text/plain": FileText,
};

function recordIcon(data: RecordNodeData): LucideIcon {
  if (data.collectionKind === "dataset-snapshot") return Database;
  switch (data.kind) {
    case "artifact":
      return ARTIFACT_MEDIA_TYPE_ICONS[data.mediaType ?? ""] ??
        (data.artifactRole === "input"
          ? FileInput
          : data.artifactRole === "output"
            ? FileOutput
            : File);
    case "artifact_set":
      return FileStack;
    case "computation":
      return SquareFunction;
    case "execution":
      return Cog;
    case "inference_service":
      return Activity;
    case "event":
      return data.status === "failed" ? CircleX : Zap;
    case "evidence":
      return data.outcome === "fail" ? CircleX : ShieldCheck;
    default:
      return File;
  }
}

function RecordNode({ data }: NodeProps) {
  const record = data as RecordNodeData;
  const Icon = recordIcon(record);
  const iconState =
    record.kind === "evidence" && record.outcome === "fail"
      ? " is-failed-evidence"
      : record.kind === "evidence" && record.outcome === "pass"
        ? " is-passed-evidence"
        : record.kind === "event" && record.status === "failed"
          ? " is-failed-event"
          : record.kind === "execution" && record.status === "failed"
            ? " is-failed-execution is-rotating"
            : record.kind === "execution" && record.status === "succeeded"
              ? " is-succeeded-execution is-rotating"
              : record.kind === "execution"
                ? " is-rotating"
                : record.kind === "event"
                  ? " is-pulsing"
                  : record.kind === "artifact_set"
                    ? " is-compressing"
                    : "";
  return (
    <div className="record-node">
      <Icon
        aria-hidden="true"
        className={"record-node-icon" + iconState}
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

function LifecycleGroupNode({ data }: NodeProps) {
  const group = data as LifecycleGroupNodeData;
  return (
    <div className="lifecycle-group-node">
      <div className="lifecycle-group-title">
        <Activity aria-hidden="true" size={18} strokeWidth={2.2} />
        <span>{group.title ?? "Lifecycle"}</span>
      </div>
      <span className="lifecycle-group-label">{group.label}</span>
      <span className="lifecycle-group-count">
        {group.recordCount} {group.recordCount === 1 ? "record" : "records"}
      </span>
    </div>
  );
}

const nodeTypes = {
  record: RecordNode,
  lifecycleGroup: LifecycleGroupNode,
  timelineTick: TimelineTick,
};

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

function recordNodeWidth(kind: string, collectionKind?: GraphNode["collection_kind"]): number {
  if (kind === "artifact_set" || collectionKind === "dataset-snapshot") return 225;
  if (kind === "execution") return 240;
  if (kind === "inference_service") return 250;
  if (kind === "artifact") return 185;
  return 215;
}

/**
 * Use the same explicit text-derived height for React Flow rendering and for
 * ELK sizing. ELK may run before React Flow has measured a newly arrived
 * provenance overlay; a realistic fallback keeps it from arranging a long
 * Artifact or Event as though it were a 62px card.
 */
function recordNodeHeight(
  kind: string,
  label: string,
  collectionKind?: GraphNode["collection_kind"],
  includeTimestamp = false,
): number {
  const width = recordNodeWidth(kind, collectionKind);
  const horizontalPadding = kind === "execution" ? 68 : kind === "artifact" ? 32 : 24;
  const textWidth = Math.max(72, width - horizontalPadding - 38);
  // Twelve-pixel UI text averages roughly 6.6px per character. Use a smaller
  // capacity than the ideal calculation to leave room for bold labels,
  // long unbroken identifiers, and the icon-side inset.
  const charactersPerLine = Math.max(10, Math.floor(textWidth / 7.2));
  const labelLines = label.split("\n").reduce(
    (count, line) => count + Math.max(1, Math.ceil(line.length / charactersPerLine)),
    0,
  );
  const timestampLines = includeTimestamp ? 1 : 0;
  const verticalPadding = kind === "execution" ? 24 : kind === "artifact" ? 16 : 18;
  const minimumHeight = kind === "execution" ? 86 : kind === "artifact" ? 62 : 68;
  return Math.max(minimumHeight, Math.ceil((labelLines + timestampLines) * 16.2 + verticalPadding + 4));
}

function timelineNodeWidth(node: GraphNode): number {
  return recordNodeWidth(node.kind, node.collection_kind);
}

function timelineNodeHeight(node: GraphNode): number {
  return recordNodeHeight(
    node.kind,
    node.label,
    node.collection_kind,
    timelineTimestamp(node) !== null,
  );
}

function computationExecutionAnchors(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Map<string, GraphNode> {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const anchors = new Map<string, GraphNode>();
  for (const edge of edges) {
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    const computation = source?.kind === "computation"
      ? source
      : target?.kind === "computation"
        ? target
        : undefined;
    const execution = source?.kind === "execution"
      ? source
      : target?.kind === "execution"
        ? target
        : undefined;
    if (!computation || !execution) continue;
    const current = anchors.get(computation.id);
    const candidateTime = timelineTimestamp(execution) ?? Number.POSITIVE_INFINITY;
    const currentTime = current ? timelineTimestamp(current) ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY;
    if (
      !current ||
      candidateTime < currentTime ||
      (candidateTime === currentTime && execution.id.localeCompare(current.id) < 0)
    ) {
      anchors.set(computation.id, execution);
    }
  }
  return anchors;
}

function eventExecutionAnchors(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Map<string, GraphNode> {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const anchors = new Map<string, GraphNode>();
  for (const edge of edges) {
    if (edge.relation !== "event-execution") continue;
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    const event = source?.kind === "event"
      ? source
      : target?.kind === "event"
        ? target
        : undefined;
    const execution = source?.kind === "execution"
      ? source
      : target?.kind === "execution"
        ? target
        : undefined;
    if (event && execution) anchors.set(event.id, execution);
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
  if (run.timeline.kind === "lifecycle" && run.timeline.started_at) {
    return "started " + new Date(run.timeline.started_at).toLocaleString();
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

function executionMatchesStatus(
  execution: RunExecution,
  statusFilter: RunStatusFilter,
): boolean {
  if (statusFilter === "all") return true;
  if (statusFilter === "needs_attention") {
    return execution.status === "failed" || execution.status === "incomplete";
  }
  return execution.status === statusFilter;
}

function executionMatchesQuery(execution: RunExecution, query: string): boolean {
  return [
    execution.label,
    execution.record_id,
    execution.status,
    execution.diagnostic?.stage ?? "",
    execution.diagnostic?.code ?? "",
    execution.diagnostic?.message ?? "",
  ]
    .join(" ")
    .toLocaleLowerCase()
    .includes(query);
}

function filteredRun(
  run: Run,
  lineage: RunLineage,
  query: string,
  statusFilter: RunStatusFilter,
): FilteredRun | null {
  const lineageMatchesQuery = [lineage.label, lineage.id]
    .join(" ")
    .toLocaleLowerCase()
    .includes(query);
  const runMatchesQuery = [run.label, run.record_id]
    .join(" ")
    .toLocaleLowerCase()
    .includes(query);
  const hasNestedWork = run.executions.some((execution) => execution.depth > 0);
  const matchingExecutions = run.executions.filter(
    (execution) =>
      executionMatchesStatus(execution, statusFilter) &&
      (!query || lineageMatchesQuery || runMatchesQuery || executionMatchesQuery(execution, query)),
  );
  const matchingWork = hasNestedWork
    ? matchingExecutions.filter((execution) => execution.depth > 0)
    : matchingExecutions;
  if (matchingWork.length === 0) return null;

  // A nested lifecycle retains its root as structural context, but only
  // matching child Executions are part of the filtered work slice.
  const visibleExecutionIds = new Set(matchingWork.map((execution) => execution.id));
  if (hasNestedWork) {
    for (const execution of run.executions) {
      if (execution.depth === 0) visibleExecutionIds.add(execution.id);
    }
  }
  return {
    run,
    executions: run.executions.filter((execution) => visibleExecutionIds.has(execution.id)),
    matchingExecutionCount: matchingWork.length,
  };
}

function filterGraphToExecutions(
  graph: GraphPayload | null,
  executionIds: Set<string> | null,
): GraphPayload | null {
  if (!graph || !executionIds) return graph;

  const allNodes = new Map(
    [...graph.nodes, ...graph.collection_nodes].map((node) => [node.id, node]),
  );
  const visibleIds = new Set(executionIds);
  // Retain direct computation, Artifact, Event, and Evidence context for the
  // matching Executions—without walking across an input Artifact to its
  // producing sibling Execution.
  for (const edge of graph.edges) {
    if (executionIds.has(edge.source) || executionIds.has(edge.target)) {
      visibleIds.add(edge.source);
      visibleIds.add(edge.target);
    }
  }
  // Events and Evidence may be one edge away from an Execution through one
  // another.  Keep that local provenance chain, but do not expand data flow.
  let addedProvenance = true;
  while (addedProvenance) {
    addedProvenance = false;
    for (const edge of graph.edges) {
      const source = allNodes.get(edge.source);
      const target = allNodes.get(edge.target);
      const sourceIsProvenance = source?.kind === "event" || source?.kind === "evidence";
      const targetIsProvenance = target?.kind === "event" || target?.kind === "evidence";
      if (
        visibleIds.has(edge.source) && targetIsProvenance && !visibleIds.has(edge.target)
      ) {
        visibleIds.add(edge.target);
        addedProvenance = true;
      }
      if (
        visibleIds.has(edge.target) && sourceIsProvenance && !visibleIds.has(edge.source)
      ) {
        visibleIds.add(edge.source);
        addedProvenance = true;
      }
    }
  }
  // A collection is part of the selected Execution's direct context when it
  // or one of its members is present. Preserve only that collection boundary
  // and its members, never a neighboring Execution.
  let addedCollections = true;
  while (addedCollections) {
    addedCollections = false;
    for (const edge of graph.collection_edges) {
      if (visibleIds.has(edge.source) && !visibleIds.has(edge.target)) {
        visibleIds.add(edge.target);
        addedCollections = true;
      }
      if (visibleIds.has(edge.target) && !visibleIds.has(edge.source)) {
        visibleIds.add(edge.source);
        addedCollections = true;
      }
    }
  }
  const include = <T extends { source: string; target: string }>(edge: T) =>
    visibleIds.has(edge.source) && visibleIds.has(edge.target);
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => visibleIds.has(node.id)),
    collection_nodes: graph.collection_nodes.filter((node) => visibleIds.has(node.id)),
    edges: graph.edges.filter(include),
    collection_edges: graph.collection_edges.filter(include),
    lifecycle_groups: graph.lifecycle_groups.map((group) => ({
      ...group,
      member_ids: group.member_ids.filter((id) => visibleIds.has(id)),
    })),
  };
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

type LifecycleGrouping = {
  groups: LifecycleGroup[];
  memberIdsByGroup: Map<string, string[]>;
};

function isArtifactCollection(node: GraphNode | undefined): boolean {
  return node?.kind === "artifact_set" || node?.collection_kind === "dataset-snapshot";
}

function collectionGrouping(
  nodes: GraphNode[],
  collectionEdges: GraphEdge[],
  expandedCollectionIds: Set<string>,
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
    // A collapsed collection is a summary node. Once a user expands it, its
    // full unshared inventory belongs inside the container—even when a member
    // has an input/output data-flow edge. Otherwise an ArtifactSet that says
    // "6 members" can appear to contain only its non-data-bound manifest.
    if (!expandedCollectionIds.has(artifactSet.id)) continue;
    const artifactIds = candidateArtifactsBySet.get(artifactSet.id);
    if (!artifactIds?.size) continue;
    // React Flow permits one parent per node. A shared Artifact remains outside
    // every box with its explicit membership arrows; every unshared member is
    // placed inside the expanded ArtifactSet, including a data-flow bridge.
    const members = nodes.filter(
      (node) =>
        artifactIds.has(node.id) &&
        candidateSetsByArtifact.get(node.id)?.size === 1,
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
  const dataBoundArtifactIds = directDataBoundArtifactIds(graph.edges);
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
      !dataBoundArtifactIds.has(memberId) &&
      !expandedCollections.has(collectionId)
    ) {
      collapsedMembers.add(memberId);
    }
  }
  return collapsedMembers;
}

function directDataBoundArtifactIds(edges: GraphEdge[]): Set<string> {
  // A collection may organize an Artifact, but must not erase a visible
  // Artifact → Execution or Execution → Artifact bridge from the Data DAG.

  const artifactIds = new Set<string>();
  for (const edge of edges) {
    if (edge.relation === "consumes") artifactIds.add(edge.source);
    if (edge.relation === "produces") artifactIds.add(edge.target);
  }
  return artifactIds;
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

function lifecycleGrouping(
  nodes: GraphNode[],
  groups: LifecycleGroup[],
): LifecycleGrouping {
  const visibleIds = new Set(nodes.map((node) => node.id));
  const visibleGroups: LifecycleGroup[] = [];
  for (const group of groups) {
    const memberIds = group.member_ids.filter((id) => visibleIds.has(id));
    // A collapsed inference-service boundary uses its virtual summary node as
    // the anchor. When expanded, that presentation node is replaced by the
    // real request Executions, so the boundary must remain valid without the
    // virtual root being visible.
    if (
      memberIds.length < 2 ||
      (group.title !== "Inference service" && !memberIds.includes(group.root_id))
    ) continue;
    const visibleGroup = { ...group, member_ids: memberIds };
    visibleGroups.push(visibleGroup);
  }
  const memberIdsByGroup = new Map<string, string[]>();
  for (const group of visibleGroups) {
    // Presentation boundaries may be nested: an inner Lifecycle owns its
    // materialization while an outer Lineage can encompass that Lifecycle
    // plus a sibling inference service.  They are drawn as borders, not
    // React Flow parent nodes, so retaining shared members is both safe and
    // necessary for the outer boundary to actually enclose the inner graph.
    memberIdsByGroup.set(group.id, group.member_ids);
  }
  return { groups: visibleGroups, memberIdsByGroup };
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
  const edges = uniqueEdges([...graph.edges, ...provenanceEdges]);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const lifecycleGroups = graph.lifecycle_groups.map((group) => {
    const memberIds = new Set(group.member_ids);
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of edges) {
        const source = nodeById.get(edge.source);
        const target = nodeById.get(edge.target);
        const sourceIsMember = memberIds.has(edge.source);
        const targetIsMember = memberIds.has(edge.target);
        const contextualNode = sourceIsMember ? target : targetIsMember ? source : undefined;
        if (
          !contextualNode ||
          memberIds.has(contextualNode.id) ||
          contextualNode.layer !== "provenance" ||
          !["event", "evidence", "computation"].includes(contextualNode.kind)
        ) {
          continue;
        }
        memberIds.add(contextualNode.id);
        changed = true;
      }
    }
    return { ...group, member_ids: [...memberIds] };
  });
  return {
    ...graph,
    nodes,
    edges,
    lifecycle_groups: lifecycleGroups,
    // Collection membership is contextual data navigation, not provenance.
    // Keep the primary view's collection projection unchanged as well.
    collection_edges: graph.collection_edges,
  };
}

function inferenceServiceStatus(service: InferenceService): GraphNode["status"] {
  if (service.status_counts.failed) return "failed";
  if (service.status_counts.incomplete) return "incomplete";
  if (service.status_counts.skipped) return "skipped";
  return service.status_counts.succeeded ? "succeeded" : undefined;
}

function inferenceServiceSummary(service: InferenceService): string {
  return [
    service.request_count + (service.request_count === 1 ? " request" : " requests"),
    statusSummary(service.status_counts),
  ].join(" · ");
}

/**
 * Collapse request-private service materializations into one presentation
 * node. The virtual node is intentionally not an OCLP record. Individual
 * requests are opened in the execution-scoped Data DAG from the explorer;
 * the Run lineage overview never silently changes to a request graph.
 */
function projectInferenceServices(graph: GraphPayload | null): GraphPayload | null {
  if (!graph || graph.view !== "run") return graph;
  const collapsedServices = graph.inference_services ?? [];
  if (!collapsedServices.length) return graph;

  const hiddenNodeIds = new Set(
    collapsedServices.flatMap((service) => service.hidden_node_ids ?? []),
  );
  const sourceNodeIds = new Set(
    graph.nodes.map((node) => node.id),
  );
  const serviceNodes: GraphNode[] = collapsedServices.map((service) => ({
    id: service.id,
    kind: "inference_service",
    record_id: service.release_id,
    label: [
      "Inference service",
      service.label,
      "▸ " + inferenceServiceSummary(service),
    ].join("\n"),
    digest: service.id,
    status: inferenceServiceStatus(service),
  }));
  const serviceEdges: GraphEdge[] = collapsedServices.flatMap((service) =>
    service.source_node_id && sourceNodeIds.has(service.source_node_id)
      ? [{
          id: "presentation:" + service.source_node_id + ":serves-release:" + service.id,
          source: service.source_node_id,
          target: service.id,
          relation: "serves-release",
        }]
      : [],
  );
  const includeEdge = (edge: GraphEdge) =>
    !hiddenNodeIds.has(edge.source) && !hiddenNodeIds.has(edge.target);
  return {
    ...graph,
    nodes: [
      ...graph.nodes.filter((node) => !hiddenNodeIds.has(node.id)),
      ...serviceNodes,
    ],
    edges: [
      ...graph.edges.filter(includeEdge),
      ...serviceEdges,
    ],
    collection_nodes: graph.collection_nodes.filter((node) => !hiddenNodeIds.has(node.id)),
    collection_edges: graph.collection_edges.filter(includeEdge),
    lifecycle_groups: graph.lifecycle_groups.map((group) => ({
      ...group,
      member_ids: [
        ...group.member_ids.filter((id) => !hiddenNodeIds.has(id)),
        ...(group.title === "Lineage" || group.title === "Inference service"
          ? serviceNodes.map((node) => node.id)
          : []),
      ],
    })),
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
  lifecycle: LifecycleGrouping,
  collectionPresentation: CollectionPresentation,
  positionOverrides: Record<string, XYPosition>,
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
          edge.relation !== "serves-release"
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
  const eventAnchors = eventExecutionAnchors(nodes, graph?.edges ?? []);
  const eventOutputIndex = new Map<string, number>();
  const eventsByExecution = new Map<string, GraphNode[]>();
  for (const event of nodes.filter((node) => node.kind === "event")) {
    const execution = eventAnchors.get(event.id);
    if (!execution) continue;
    const events = eventsByExecution.get(execution.id) ?? [];
    events.push(event);
    eventsByExecution.set(execution.id, events);
  }
  for (const events of eventsByExecution.values()) {
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
    ...nodes.filter(
      (node) =>
        !groupedSetIds.has(node.id) &&
        !memberNodeIds.has(node.id),
    ),
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
        : node.kind === "computation" ||
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
    const isExecution = node.kind === "execution";
    const isFailedEvidence = node.kind === "evidence" && node.outcome === "fail";
    const isFailedEvent = node.kind === "event" && node.status === "failed";
    const isPassedEvidence = node.kind === "evidence" && node.outcome === "pass";
    const isFailedExecution = isExecution && node.status === "failed";
    const isSucceededExecution = isExecution && node.status === "succeeded";
    const isFailedRecord = isFailedEvidence || isFailedEvent || isFailedExecution;
    const isPassedRecord = isPassedEvidence || isSucceededExecution;
    const isProvenance = node.layer === "provenance";
    const isCollection = options.collection === true;
    const isCollectionNode = isArtifactCollection(node);
    const isTimeline = graph?.view === "timeline";
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
        outcome: node.outcome,
        status: node.status,
        mediaType: node.media_type,
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
          isFailedRecord
            ? "2px solid #ff1744"
            : isPassedRecord
              ? "2px solid #39ff88"
            : isSelected
            ? "2px solid " + theme.selection
            : (isProvenance ? "1px dashed " : "1px solid ") +
              (theme.kinds[node.kind] ?? theme.referenceEdge),
        boxShadow: [
          selectionGlow,
          isFailedRecord ? "0 0 14px rgb(255 23 68 / 0.72)" : null,
          isPassedRecord ? "0 0 14px rgb(57 255 136 / 0.66)" : null,
          ...collectionStack,
        ].filter(Boolean).join(", ") || undefined,
        borderRadius: isCollection ? 14 : isArtifact ? 999 : isExecution ? 0 : 10,
        clipPath: isExecution
          ? "polygon(12% 0, 88% 0, 100% 50%, 88% 100%, 12% 100%, 0 50%)"
          : undefined,
        color: theme.nodeText,
        fontSize: isCollectionNode ? 11 : 12,
        fontWeight: isCollectionNode ? 700 : undefined,
        lineHeight: 1.35,
        padding: isCollectionNode
          ? "9px 12px"
          : isExecution
            ? "12px 34px"
            : isArtifact
              ? "8px 16px"
              : 10,
        width: isTimeline ? timelineNodeWidth(node) : recordNodeWidth(node.kind, node.collection_kind),
        height: isCollection
          ? 58 + (artifactSets.memberNodesBySet.get(node.id)?.length ?? 0) * 70
          : isTimeline
            ? timelineNodeHeight(node)
            : recordNodeHeight(node.kind, node.label, node.collection_kind),
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
    const computationAnchors = computationExecutionAnchors(nodes, graph.edges);
    const xFor = (node: GraphNode) => {
      if (node.timeline_role === "input" && timelineTimestamp(node) === null) {
        return untimedInputX;
      }
      const anchor = node.kind === "computation" ? computationAnchors.get(node.id) : undefined;
      const timestamp = timelineTimestamp(anchor ?? node) ?? axisStart;
      return TIMELINE_AXIS_LEFT + ((timestamp - axisStart) / axisSpan) * axisWidth;
    };
    const executionLanes = nodes
      .filter((node) => node.kind === "execution")
      .sort((left, right) => {
        const depth = Number(left.timeline_depth ?? 0) - Number(right.timeline_depth ?? 0);
        return depth || provenanceTimelineOrder(left, right);
      });
    const laneIndex = new Map(executionLanes.map((node, index) => [node.id, index]));
    const unassignedLane = executionLanes.length;
    const placements = [...nodes]
      .sort(provenanceTimelineOrder)
      .map((node) => ({
        node,
        x: xFor(node),
        lane: laneIndex.get(
          node.timeline_lane ??
            (node.kind === "computation" ? computationAnchors.get(node.id)?.id : undefined) ??
            node.id,
        ) ?? unassignedLane,
      }));
    const tracksByKey = new Map<string, { end: number; height: number }[]>();
    const placementTracks = new Map<string, number>();
    for (const placement of placements) {
      const trackKey = placement.lane + ":" + timelineTrackKind(placement.node);
      const nodeWidth = timelineNodeWidth(placement.node);
      const nodeHeight = timelineNodeHeight(placement.node);
      const tracks = tracksByKey.get(trackKey) ?? [];
      let track = tracks.findIndex(({ end }) => end <= placement.x - nodeWidth - 24);
      if (track === -1) {
        track = tracks.length;
        tracks.push({ end: placement.x + nodeWidth, height: nodeHeight });
      } else {
        tracks[track] = {
          end: placement.x + nodeWidth,
          height: Math.max(tracks[track].height, nodeHeight),
        };
      }
      tracksByKey.set(trackKey, tracks);
      placementTracks.set(placement.node.id, track);
    }
    const tracksFor = (lane: number, kind: string) => tracksByKey.get(lane + ":" + kind) ?? [];
    const trackOffset = (tracks: { height: number }[], track: number) =>
      tracks.slice(0, track).reduce((offset, current) => offset + current.height + TIMELINE_TRACK_GAP, 0);
    const bandHeight = (lane: number, kind: string) =>
      tracksFor(lane, kind).reduce(
        (height, track, index) => height + track.height + (index > 0 ? TIMELINE_TRACK_GAP : 0),
        0,
      );
    const bandOffset = (lane: number, kind: string) => {
      let offset = 0;
      for (const candidate of TIMELINE_TRACK_KINDS) {
        if (candidate === kind) return offset;
        const height = bandHeight(lane, candidate);
        if (height > 0) offset += height + TIMELINE_SECTION_GAP;
      }
      return offset;
    };
    const hasUnassignedLane = placements.some((placement) => placement.lane === unassignedLane);
    const laneCount = executionLanes.length + (hasUnassignedLane ? 1 : 0);
    const laneStarts = new Map<number, number>();
    let nextLaneY = 0;
    for (let lane = 0; lane < laneCount; lane += 1) {
      laneStarts.set(lane, nextLaneY);
      const populatedBandHeights = TIMELINE_TRACK_KINDS.map((kind) => bandHeight(lane, kind)).filter(
        (height) => height > 0,
      );
      nextLaneY += Math.max(
        205,
        60 +
          populatedBandHeights.reduce(
            (height, band, index) => height + band + (index > 0 ? TIMELINE_SECTION_GAP : 0),
            0,
          ),
      );
    }
    const timelineNodes = placements.map(({ node, x, lane }) => {
      const laneY = laneStarts.get(lane) ?? 0;
      const track = placementTracks.get(node.id) ?? 0;
      const kind = timelineTrackKind(node);
      return renderNode(node, {
        x,
        y: laneY + bandOffset(lane, kind) + trackOffset(tracksFor(lane, kind), track),
      });
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

  const rootNodes = [
    ...groupedSetNodes,
    ...nodes.filter(
      (node) => !groupedSetIds.has(node.id) && !memberNodeIds.has(node.id),
    ),
  ];
  const rootPositionById = new Map<string, XYPosition>();
  for (const node of rootNodes) {
    const members = artifactSets.memberNodesBySet.get(node.id) ?? [];
    const slots = members.length
      ? Math.max(1, Math.ceil((58 + members.length * 70) / 140))
      : 1;
    rootPositionById.set(
      node.id,
      positionOverrides[node.id] ?? positionFor(node, slots).position,
    );
  }
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const rendered: Node[] = [];
  const lifecycleLayouts = lifecycle.groups.flatMap((group) => {
    const memberIds = lifecycle.memberIdsByGroup.get(group.id) ?? [];
    const directMembers = memberIds
      .filter((memberId) => !artifactSets.parentSetByArtifact.has(memberId))
      .flatMap((memberId) => {
        const node = nodeById.get(memberId);
        const position = rootPositionById.get(memberId);
        return node && position ? [{ node, position }] : [];
      });
    if (directMembers.length < 2) return [];
    const nodeSize = (node: GraphNode) => {
      const members = artifactSets.memberNodesBySet.get(node.id) ?? [];
      return {
        width: recordNodeWidth(node.kind, node.collection_kind),
        height: members.length
          ? 58 + members.length * 70
          : recordNodeHeight(node.kind, node.label, node.collection_kind),
      };
    };
    const left = Math.min(...directMembers.map(({ position }) => position.x));
    const top = Math.min(...directMembers.map(({ position }) => position.y));
    const right = Math.max(
      ...directMembers.map(({ node, position }) => position.x + nodeSize(node).width),
    );
    const bottom = Math.max(
      ...directMembers.map(({ node, position }) => position.y + nodeSize(node).height),
    );
    return [{
      group,
      memberIds,
      left,
      top,
      width: Math.max(360, right - left + 44),
      height: Math.max(160, bottom - top + 76),
    }];
  });
  for (const layout of lifecycleLayouts) {
    const isOuterLineage = layout.group.title === "Lineage";
    const isInferenceServiceBoundary = layout.group.title === "Inference service";
    const boundaryColor = isOuterLineage || isInferenceServiceBoundary
      ? theme.kinds.inference_service
      : theme.kinds.execution;
    rendered.push({
      id: layout.group.id,
      type: "lifecycleGroup",
      position: { x: layout.left - 22, y: layout.top - 48 },
      data: {
        title: layout.group.title,
        label: layout.group.label,
        recordCount: layout.memberIds.length,
      },
      selectable: false,
      draggable: false,
      connectable: false,
      focusable: false,
      style: {
        background: "color-mix(in srgb, " + boundaryColor + " 6%, transparent)",
        border: "1px dashed " + boundaryColor,
        borderRadius: 18,
        color: theme.nodeText,
        width: layout.width,
        height: layout.height,
        zIndex: isOuterLineage ? -2 : -1,
      },
    });
  }
  const renderRoot = (node: GraphNode) => {
    const position = rootPositionById.get(node.id)!;
    const members = artifactSets.memberNodesBySet.get(node.id) ?? [];
    if (members.length) {
      rendered.push(renderNode(node, position, { collection: true }));
      members.forEach((member, index) => {
        rendered.push(
          renderNode(member, { x: 20, y: 48 + index * 70 }, { parentId: node.id }),
        );
      });
      return;
    }
    rendered.push(renderNode(node, position));
  };
  for (const node of rootNodes) renderRoot(node);
  return rendered;
}

const REVERSED_REFERENCE_FLOW_RELATIONS = new Set([
  "contains",
  "dataset-partition",
  "computation",
  "evidence-subject",
  "event-execution",
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
          ? theme.kinds.computation
          : edge.relation === "serves-release"
            ? theme.kinds.inference_service
          : edge.relation === "dataset-partition"
            ? theme.kinds.artifact
            : edge.relation === "contains"
              ? theme.kinds.artifact_set
              : edge.relation === "orchestrates"
                ? theme.kinds.execution
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

function renderedDimension(value: unknown, fallback: number): number {
  if (typeof value === "number" && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function layoutNodeSize(node: Node): { width: number; height: number } {
  const data = node.data as Partial<RecordNodeData>;
  const fallbackWidth = recordNodeWidth(data.kind ?? "", data.collectionKind);
  const fallbackHeight = recordNodeHeight(
    data.kind ?? "",
    data.label ?? "",
    data.collectionKind,
  );
  return {
    width: node.measured?.width ?? node.width ?? renderedDimension(node.style?.width, fallbackWidth),
    height:
      node.measured?.height ??
      node.height ??
      renderedDimension(node.style?.height, fallbackHeight),
  };
}

/**
 * Project visible React Flow nodes into a layered ELK graph. Member Artifacts
 * are represented by their containing ArtifactSet so expanded groups retain
 * their box layout while their data dependencies still influence placement.
 */
async function arrangeGraphNodes(nodes: Node[], edges: Edge[]): Promise<Record<string, XYPosition>> {
  const rootNodes = nodes.filter(
    (node) =>
      node.type !== "timelineTick" &&
      node.type !== "lifecycleGroup" &&
      node.parentId === undefined,
  );
  if (rootNodes.length < 2) return {};

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const rootIds = new Set(rootNodes.map((node) => node.id));
  const rootFor = (nodeId: string): string | null => {
    let current = nodeById.get(nodeId);
    const visited = new Set<string>();
    while (current?.parentId && !visited.has(current.id)) {
      visited.add(current.id);
      current = nodeById.get(current.parentId);
    }
    return current && rootIds.has(current.id) ? current.id : null;
  };

  const projectedEdges = new Map<string, { id: string; sources: string[]; targets: string[] }>();
  for (const edge of edges) {
    const source = rootFor(edge.source);
    const target = rootFor(edge.target);
    if (!source || !target || source === target) continue;
    const key = source + "→" + target;
    if (!projectedEdges.has(key)) {
      projectedEdges.set(key, { id: "layout:" + key, sources: [source], targets: [target] });
    }
  }

  const layout = await elk.layout({
    id: "cyclops-visible-graph",
    layoutOptions: ELK_LAYOUT_OPTIONS,
    children: rootNodes.map((node) => {
      const size = layoutNodeSize(node);
      return { id: node.id, width: size.width, height: size.height };
    }),
    edges: [...projectedEdges.values()],
  });

  return Object.fromEntries(
    (layout.children ?? []).flatMap((node) =>
      node.x === undefined || node.y === undefined
        ? []
        : [[node.id, { x: Math.round(node.x + 56), y: Math.round(node.y + 56) }]],
    ),
  );
}

export default function App() {
  const [graph, setGraph] = useState<GraphPayload | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [lineages, setLineages] = useState<RunLineage[]>([]);
  const [selectedLineage, setSelectedLineage] = useState<string>();
  const [selectedRun, setSelectedRun] = useState<string>();
  const [selectedInvocation, setSelectedInvocation] = useState<string>();
  const [selectedInferenceService, setSelectedInferenceService] = useState<string>();
  const [isLineageScope, setIsLineageScope] = useState(false);
  const [expandedLineages, setExpandedLineages] = useState<Set<string>>(new Set());
  const [runFilter, setRunFilter] = useState("");
  const [runStatusFilter, setRunStatusFilter] =
    useState<RunStatusFilter>("all");
  const [selected, setSelected] = useState<RecordPayload | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [isSelectedLoading, setIsSelectedLoading] = useState(false);
  const [selectedRecordError, setSelectedRecordError] = useState<string | null>(null);
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
  // Sidebar disclosure is navigation state only. It must not replace the
  // inference-service summary on the canvas with its request-level graph.
  const [expandedInferenceServiceTreeIds, setExpandedInferenceServiceTreeIds] = useState<Set<string>>(
    new Set(),
  );
  const [nodePositionsByScope, setNodePositionsByScope] =
    useState<NodePositionsByScope>({});
  const [layoutRequest, setLayoutRequest] = useState(0);
  const [isAutoArranging, setIsAutoArranging] = useState(false);
  const flow = useRef<ReactFlowInstance | null>(null);
  const graphPanelRef = useRef<HTMLDivElement | null>(null);
  const selectedRecordRequest = useRef<AbortController | null>(null);
  const didInitialize = useRef(false);
  const completedLayoutRequests = useRef(new Set<string>());
  const theme = GRAPH_THEMES[themeName];
  const normalizedRunFilter = runFilter.trim().toLocaleLowerCase();
  const hasRunFilter =
    Boolean(normalizedRunFilter) || runStatusFilter !== "all";
  const activeLineage = useMemo(
    () =>
      lineages.find((lineage) => lineage.id === selectedLineage) ??
      lineages.find((lineage) =>
        lineage.runs.some((run) => run.id === selectedRun),
      ),
    [lineages, selectedLineage, selectedRun],
  );
  const activeRun = useMemo(
    () => runs.find((run) => run.id === selectedRun),
    [runs, selectedRun],
  );
  const graphScopeLabel =
    baseView === "timeline"
      ? "Timeline"
      : baseView === "derivation"
        ? "Execution data graph"
        : selectedInferenceService
          ? "Inference service overview"
          : isLineageScope
            ? "Lineage overview"
            : "Run overview";
  const canvasExecutionIds = useMemo<Set<string> | null>(() => {
    if (!hasRunFilter) return null;
    if (!activeLineage || !activeRun) return new Set();
    return new Set(
      (filteredRun(
        activeRun,
        activeLineage,
        normalizedRunFilter,
        runStatusFilter,
      )?.executions ?? []).map((execution) => execution.id),
    );
  }, [activeLineage, activeRun, hasRunFilter, normalizedRunFilter, runStatusFilter]);
  const displayGraph = useMemo(
    () =>
      projectInferenceServices(
        filterGraphToExecutions(
          mergeProvenanceOverlay(graph, isProvenanceVisible ? provenanceGraph : null),
          canvasExecutionIds,
        ),
      ),
    [
      canvasExecutionIds,
      graph,
      isProvenanceVisible,
      provenanceGraph,
    ],
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
    execution?: string,
    path?: string,
    service?: string,
    lineage = false,
  ) => {
    try {
      setError(null);
      const parameters = new URLSearchParams({ view });
      if (run) parameters.set("run", run);
      if (execution && (view === "derivation" || view === "provenance" || view === "timeline")) {
        parameters.set("execution", execution);
      }
      if (service && view === "run") parameters.set("service", service);
      if (lineage && view === "run") parameters.set("lineage", "true");
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

  const loadProvenanceOverlay = useCallback(async (run?: string, execution?: string) => {
    if (!run && !execution) {
      setProvenanceGraph(null);
      return false;
    }
    try {
      const parameters = new URLSearchParams({ view: "provenance" });
      if (run) parameters.set("run", run);
      if (execution) parameters.set("execution", execution);
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
        // A run selection represents the full lifecycle. A child Execution is
        // selected only when the user explicitly clicks it in the explorer.
        setSelectedInvocation(undefined);
        setSelectedInferenceService(undefined);
        setIsLineageScope(false);
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
            baseView === "derivation" || baseView === "timeline"
              ? selectedInvocation
              : undefined,
            undefined,
            undefined,
            baseView === "run" && isLineageScope,
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
  }, [baseView, isLineageScope, isProvenanceVisible, loadGraph, loadProvenanceOverlay, loadRuns, selectedInvocation, selectedRun]);

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
    () =>
      collectionGrouping(
        visibleNodes,
        displayGraph?.collection_edges ?? [],
        expandedCollections,
      ),
    [displayGraph?.collection_edges, expandedCollections, visibleNodes],
  );
  const groupedLifecycles = useMemo(
    () => lifecycleGrouping(visibleNodes, displayGraph?.lifecycle_groups ?? []),
    [displayGraph?.lifecycle_groups, visibleNodes],
  );
  const selectedDependencyTrace = useMemo(
    () => dependencyTraceEdgeIds(visibleEdges, selectedNodeId),
    [selectedNodeId, visibleEdges],
  );
  const memberCounts = useMemo(() => collectionMemberCounts(displayGraph), [displayGraph]);
  const layoutScope = useMemo(
    () =>
      [
        GRAPH_LAYOUT_VERSION,
        displayGraph?.view ?? "unloaded",
        // A provenance overlay adds an entirely different node set. It owns a
        // distinct arrangement so overlay nodes are never left at the base
        // graph's fallback positions and so toggling it off restores the
        // user's previous data-only placement.
        isProvenanceVisible ? "with-provenance" : "without-provenance",
        selectedRun ?? "",
        selectedInferenceService ?? "",
        displayGraph?.view === "derivation" || displayGraph?.view === "timeline"
          ? selectedInvocation ?? ""
          : "",
      ].join(":"),
    [
      displayGraph?.view,
      isProvenanceVisible,
      selectedInferenceService,
      selectedInvocation,
      selectedRun,
    ],
  );
  const nodes = useMemo(
    () =>
      flowNodes(
        displayGraph,
        visibleNodes,
        theme,
        selectedNodeId,
        groupedCollections,
        groupedLifecycles,
        {
          memberCounts,
          expandedIds: expandedCollections,
        },
        nodePositionsByScope[layoutScope] ?? {},
      ),
    [
      displayGraph,
      expandedCollections,
      groupedCollections,
      groupedLifecycles,
      memberCounts,
      layoutScope,
      nodePositionsByScope,
      selectedNodeId,
      theme,
      visibleNodes,
    ],
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
  // A provenance overlay is fetched independently from the base graph. Its
  // arrival changes the ELK input after the Data DAG may already have been
  // arranged, so completion must be scoped to the actual visible graph—not
  // merely to the selected run and view.
  const layoutContentKey = useMemo(
    () =>
      [
        ...nodes
          .filter((node) => node.type !== "timelineTick")
          .map((node) => "node:" + node.id + ":" + (node.parentId ?? "root")),
        ...edges.map((edge) => "edge:" + edge.source + "→" + edge.target),
      ]
        .sort()
        .join("|"),
    [edges, nodes],
  );

  useEffect(() => {
    if (!displayGraph || displayGraph.view === "timeline" || nodes.length < 2) return;
    const requestKey = layoutScope + ":" + layoutRequest + ":" + layoutContentKey;
    if (completedLayoutRequests.current.has(requestKey)) return;

    let cancelled = false;
    const frame = window.requestAnimationFrame(() => {
      if (cancelled) return;
      completedLayoutRequests.current.add(requestKey);
      setIsAutoArranging(true);
      // React Flow has measured the rendered label and collection boxes by the
      // next frame. Keep the explicit node-size fallback for the first mount.
      const layoutNodes = flow.current?.getNodes() ?? nodes;
      void arrangeGraphNodes(layoutNodes, edges)
        .then((positions) => {
          if (cancelled) return;
          setNodePositionsByScope((current) => ({
            ...current,
            [layoutScope]: positions,
          }));
          window.requestAnimationFrame(() => {
            if (!cancelled) flow.current?.fitView({ duration: 260, padding: 0.18 });
          });
        })
        .catch(() => {
          if (!cancelled) setError("CYCLOPS could not automatically arrange this graph.");
        })
        .finally(() => {
          if (!cancelled) setIsAutoArranging(false);
        });
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [displayGraph, edges, layoutContentKey, layoutRequest, layoutScope, nodes]);

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

  const autoArrange = useCallback(() => {
    if (!displayGraph || displayGraph.view === "timeline") return;
    setNodePositionsByScope((current) => {
      if (!current[layoutScope]) return current;
      const next = { ...current };
      delete next[layoutScope];
      return next;
    });
    setLayoutRequest((current) => current + 1);
  }, [displayGraph, layoutScope]);

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
    setSelectedRecordError(null);
    setCopied(false);
  }, []);

  const selectNode: NodeMouseHandler = useCallback(async (_event, node) => {
    // Lifecycle boundaries are structural React Flow nodes, not OCLP records.
    // Treat a click on one exactly like a click on the empty canvas.
    const inferenceService = (displayGraph?.inference_services ?? []).find(
      (service) => service.id === node.id,
    );
    if (inferenceService) {
      clearSelectedRecord();
      // An inference service is a CYCLOPS presentation group, not an OCLP
      // record with JSON to inspect. Single-clicking it preserves the canvas;
      // double-clicking is the explicit action that reveals request details.
      return;
    }
    if (node.type !== "record" || !graphNodeById.has(node.id)) {
      clearSelectedRecord();
      return;
    }
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
    setSelectedRecordError(null);
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
      // A detail request may finish just after the user clears or changes a
      // selection. It must never turn a stale record lookup into an app-level
      // graph error.
      if (
        (loadError as Error).name !== "AbortError" &&
        selectedRecordRequest.current === controller
      ) {
        setSelectedRecordError((loadError as Error).message);
      }
    } finally {
      if (selectedRecordRequest.current === controller) {
        selectedRecordRequest.current = null;
        setIsSelectedLoading(false);
      }
    }
  }, [clearSelectedRecord, displayGraph?.inference_services, graphNodeById, selectedNodeId]);

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

  const toggleInferenceServiceTree = useCallback((serviceId: string) => {
    setExpandedInferenceServiceTreeIds((current) => {
      const next = new Set(current);
      if (next.has(serviceId)) next.delete(serviceId);
      else next.add(serviceId);
      return next;
    });
  }, []);

  const toggleSelectedCollection = useCallback(() => {
    if (selected) toggleCollection(selected.digest);
  }, [selected, toggleCollection]);

  const toggleCollectionNode: NodeMouseHandler = useCallback(
    (_event, node) => {
      if ((displayGraph?.inference_services ?? []).some((service) => service.id === node.id)) {
        // A service stays a stable roll-up in Run lineage. Select one of its
        // request Executions from the explorer to inspect its Data DAG.
        return;
      }
      toggleCollection(node.id);
    },
    [displayGraph?.inference_services, toggleCollection],
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

  const showTimeline = useCallback(() => {
    if (!selectedRun) {
      setError("Select a run or Execution in the explorer before opening its timeline.");
      return;
    }
    setSelectedInferenceService(undefined);
    setIsLineageScope(false);
    setBaseView("timeline");
    void loadGraph("timeline", selectedRun, selectedInvocation);
  }, [loadGraph, selectedInvocation, selectedRun]);

  const toggleProvenance = useCallback(() => {
    if (isProvenanceVisible) {
      setIsProvenanceVisible(false);
      setProvenanceGraph(null);
      return;
    }
    if (!selectedRun && !selectedInvocation) {
      setError("Select a lifecycle run or an Execution before showing provenance context.");
      return;
    }
    if (selectedInferenceService) {
      setError("Expand the inference service and select a request to inspect its provenance.");
      return;
    }
    setIsProvenanceVisible(true);
    void loadProvenanceOverlay(selectedRun, selectedInvocation).then((loaded) => {
      if (!loaded) setIsProvenanceVisible(false);
    });
  }, [isProvenanceVisible, loadProvenanceOverlay, selectedInferenceService, selectedInvocation, selectedRun]);

  useEffect(() => {
    setCopied(false);
  }, [selected?.digest]);

  const showLineage = useCallback(() => {
    if (selected) {
      const view = graph?.view ?? "run";
      const parameters = new URLSearchParams({ depth: "3", view });
      if (selectedRun) parameters.set("run", selectedRun);
      if (selectedInvocation && view !== "run") {
        parameters.set("execution", selectedInvocation);
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
    setSelectedInvocation(undefined);
    setSelectedInferenceService(undefined);
    setIsLineageScope(true);
    setExpandedLineages((current) => new Set([...current, lineageId]));
    setExpandedCollections(new Set());
    setBaseView("run");
    void loadGraph("run", run?.id, undefined, undefined, undefined, true);
    if (isProvenanceVisible) {
      void loadProvenanceOverlay(run?.id);
    }
  }, [clearSelectedRecord, isProvenanceVisible, lineages, loadGraph, loadProvenanceOverlay]);

  const selectRun = useCallback((lineageId: string, runId: string) => {
    const selected = runId || undefined;
    clearSelectedRecord();
    setSelectedLineage(lineageId || undefined);
    setSelectedRun(selected);
    setSelectedInvocation(undefined);
    setSelectedInferenceService(undefined);
    setIsLineageScope(false);
    setExpandedLineages((current) => new Set([...current, lineageId]));
    setExpandedCollections(new Set());
    setBaseView("run");
    void loadGraph("run", selected);
    if (isProvenanceVisible) {
      void loadProvenanceOverlay(selected);
    }
  }, [clearSelectedRecord, isProvenanceVisible, loadGraph, loadProvenanceOverlay]);

  const selectExecution = useCallback((lineageId: string, runId: string, executionId: string) => {
    clearSelectedRecord();
    setSelectedLineage(lineageId || undefined);
    setSelectedRun(runId);
    setSelectedInvocation(executionId || undefined);
    // A child is a concrete Execution: its canvas is always the exact
    // Artifact → Execution → Artifact data graph. The explorer, not a second
    // toolbar control, owns this scope change.
    setSelectedInferenceService(undefined);
    setIsLineageScope(false);
    setExpandedLineages((current) => new Set([...current, lineageId]));
    setExpandedCollections(new Set());
    setBaseView("derivation");
    void loadGraph("derivation", runId, executionId || undefined);
    if (isProvenanceVisible) {
      void loadProvenanceOverlay(runId, executionId || undefined);
    }
  }, [clearSelectedRecord, isProvenanceVisible, loadGraph, loadProvenanceOverlay]);

  const selectInferenceService = useCallback((lineageId: string, service: InferenceService) => {
    const firstRequest = service.requests?.[0];
    if (!firstRequest) return;
    clearSelectedRecord();
    setSelectedLineage(lineageId || undefined);
    setSelectedRun(firstRequest.run_id);
    setSelectedInvocation(undefined);
    setSelectedInferenceService(service.id);
    setIsLineageScope(false);
    setExpandedInferenceServiceTreeIds((current) => new Set([...current, service.id]));
    setExpandedLineages((current) => new Set([...current, lineageId]));
    setExpandedCollections(new Set());
    setBaseView("run");
    // The service heading has one stable compact overview: its real release
    // ArtifactSet handed off to the virtual service roll-up. This is a
    // deliberate service selection, not a side effect of expanding the
    // sidebar or selecting a request Execution.
    setIsProvenanceVisible(false);
    setProvenanceGraph(null);
    void loadGraph("run", firstRequest.run_id, undefined, undefined, service.id);
  }, [clearSelectedRecord, loadGraph]);

  const toggleLineage = useCallback((lineageId: string) => {
    setExpandedLineages((current) => {
      const next = new Set(current);
      if (next.has(lineageId)) next.delete(lineageId);
      else next.add(lineageId);
      return next;
    });
  }, []);

  const filteredLineages = useMemo<FilteredLineage[]>(() => {
    return lineages.flatMap((lineage) => {
      const matchingRuns = lineage.runs.flatMap((run) => {
        const filtered = filteredRun(
          run,
          lineage,
          normalizedRunFilter,
          runStatusFilter,
        );
        return filtered ? [filtered] : [];
      });
      if (matchingRuns.length === 0) return [];
      return [{
        lineage,
        runs: matchingRuns,
        matchingExecutionCount: matchingRuns.reduce(
          (count, run) => count + run.matchingExecutionCount,
          0,
        ),
      }];
    });
  }, [lineages, normalizedRunFilter, runStatusFilter]);
  const matchingExecutionCount = useMemo(
    () => filteredLineages.reduce((count, lineage) => count + lineage.matchingExecutionCount, 0),
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
          {summary?.incomplete_execution_count ? (
            <span>{summary.incomplete_execution_count} incomplete execution(s)</span>
          ) : null}
          <div className="view-controls">
            <span className="current-graph-scope" title="The graph currently shown on the canvas">
              {graphScopeLabel}
            </span>
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
            <button
              aria-label="Automatically arrange the current graph"
              className="auto-arrange"
              disabled={!displayGraph || displayGraph.view === "timeline" || isAutoArranging}
              onClick={autoArrange}
              title={
                displayGraph?.view === "timeline"
                  ? "Timeline positions are pinned to time"
                  : "Arrange visible nodes without overlaps"
              }
            >
              {isAutoArranging ? "Arranging…" : "Auto-arrange"}
            </button>
            <div className="view-toggle" role="group" aria-label="Graph view">
              <button
                aria-pressed={baseView === "timeline"}
                className={baseView === "timeline" ? "is-active" : undefined}
                disabled={!selectedRun}
                onClick={showTimeline}
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
              disabled={!graph || (!selectedRun && !selectedInvocation)}
              onClick={toggleProvenance}
              role="switch"
              title={
                selectedInvocation
                  ? "Show provenance context for the selected Execution"
                  : "Show provenance context for the selected lifecycle run"
              }
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
                {" · "}{runs.length} run{runs.length === 1 ? "" : "s"}
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
            aria-label="Search lineages, runs, and executions"
            onChange={(event) => setRunFilter(event.target.value)}
            placeholder="Search lineages, runs, and executions"
            type="search"
            value={runFilter}
          />
          <div className="run-filter-controls" role="group" aria-label="Filter executions by status">
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
              {matchingExecutionCount} matching execution{matchingExecutionCount === 1 ? "" : "s"}
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
                        {lineage.root_count} run{lineage.root_count === 1 ? "" : "s"}
                        {lineage.inference_services.length
                          ? " · " + lineage.inference_services.length + " inference service" +
                            (lineage.inference_services.length === 1 ? "" : "s")
                          : ""}
                        {" · "}{statusSummary(lineage.status_counts)}
                        {" · "}{lineage.artifact_count} artifact{lineage.artifact_count === 1 ? "" : "s"}
                      </small>
                    </button>
                  </div>
                  {expanded ? (
                    <div className="lineage-tree-runs" role="group">
                      {lineageRuns.map(({ run, executions }) => (
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
                            <span>Run · {run.label}</span>
                            <small>
                              {statusSummary(run.status_counts)}
                              {" · "}{run.artifact_count} artifact{run.artifact_count === 1 ? "" : "s"}
                              {timelineSummary(run) ? " · " + timelineSummary(run) : ""}
                            </small>
                          </button>
                          <div className="run-tree-children" role="group">
                            {executions.map((execution) => (
                              <button
                                aria-current={selectedInvocation === execution.id ? "true" : undefined}
                                className={
                                  "run-tree-invocation" +
                                  (selectedInvocation === execution.id && baseView !== "run"
                                    ? " is-active"
                                    : "")
                                }
                                key={execution.id}
                                onClick={() => selectExecution(lineage.id, run.id, execution.id)}
                                style={{ paddingLeft: 14 + execution.depth * 18 }}
                                title={[
                                  execution.record_id,
                                  diagnosticText(execution.diagnostic),
                                ].filter(Boolean).join("\n")}
                              >
                                <span
                                  aria-hidden="true"
                                  className={
                                    "run-status status-" + (execution.status ?? "incomplete")
                                  }
                                >
                                  ●
                                </span>
                                <span className="run-tree-invocation-copy">
                                  <span>
                                    {statusLabel(execution.status)}
                                    {" · "}{execution.label}
                                  </span>
                                  {diagnosticText(execution.diagnostic) ? (
                                    <small>
                                      {diagnosticText(execution.diagnostic)}
                                    </small>
                                  ) : null}
                                </span>
                              </button>
                            ))}
                          </div>
                        </section>
                      ))}
                      {lineage.inference_services.map((service) => {
                        const expandedService = expandedInferenceServiceTreeIds.has(service.id);
                        const requests = service.requests ?? [];
                        return (
                          <section className="lineage-tree-run inference-service-tree" key={service.id}>
                            <div className="inference-service-tree-heading">
                              <button
                                aria-expanded={expandedService}
                                aria-label={(expandedService ? "Collapse " : "Expand ") + service.label}
                                className="run-tree-disclosure"
                                onClick={() => toggleInferenceServiceTree(service.id)}
                              >
                                {expandedService ? "▾" : "▸"}
                              </button>
                              <button
                                aria-current={
                                  selectedRun && requests.some((request) => request.run_id === selectedRun)
                                    ? "true"
                                    : undefined
                                }
                                className={
                                  "lineage-tree-run-heading" +
                                  (selectedRun && requests.some((request) => request.run_id === selectedRun)
                                    ? " is-active"
                                    : "")
                                }
                                onClick={() => selectInferenceService(lineage.id, service)}
                                title={service.release_id}
                              >
                                <span>Inference service · {service.label}</span>
                                <small>{inferenceServiceSummary(service)}</small>
                              </button>
                            </div>
                            {expandedService ? (
                              <div className="run-tree-children" role="group">
                                {requests.map((execution) => (
                                  <button
                                    aria-current={selectedInvocation === execution.id ? "true" : undefined}
                                    className={
                                      "run-tree-invocation" +
                                      (selectedInvocation === execution.id && baseView !== "run"
                                        ? " is-active"
                                        : "")
                                    }
                                    key={execution.id}
                                    onClick={() =>
                                      selectExecution(lineage.id, execution.run_id, execution.id)
                                    }
                                    style={{ paddingLeft: 14 }}
                                    title={[
                                      execution.record_id,
                                      diagnosticText(execution.diagnostic),
                                    ].filter(Boolean).join("\n")}
                                  >
                                    <span
                                      aria-hidden="true"
                                      className={
                                        "run-status status-" + (execution.status ?? "incomplete")
                                      }
                                    >
                                      ●
                                    </span>
                                    <span className="run-tree-invocation-copy">
                                      <span>
                                        {statusLabel(execution.status)}
                                        {" · "}{execution.label}
                                      </span>
                                      {diagnosticText(execution.diagnostic) ? (
                                        <small>{diagnosticText(execution.diagnostic)}</small>
                                      ) : null}
                                    </span>
                                  </button>
                                ))}
                              </div>
                            ) : null}
                          </section>
                        );
                      })}
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
          ) : selectedRecordError ? (
            <p className="record-load-error">{selectedRecordError}</p>
          ) : (
            <p>
              Select a lineage or run for its lifecycle overview. Select an
              Execution for its strict Artifact → Execution → Artifact data
              graph. A Lifecycle boundary contains the run's real Executions,
              direct Artifacts, ArtifactSets, and Computations without turning
              orchestration into a flow edge. Timeline is an explicit
              chronology view; the Provenance switch adds context for the
              current selection. Double-click a collection to expand or
              collapse its member Artifacts.
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
