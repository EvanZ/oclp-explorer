import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type ReactFlowInstance,
} from "@xyflow/react";

import type {
  Diagnostic,
  GraphEdge,
  GraphNode,
  GraphPayload,
  RecordPayload,
  Run,
  RunInvocation,
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
type GraphTheme = {
  grid: string;
  minimap: string;
  minimapMask: string;
  nodeBackground: string;
  nodeText: string;
  selection: string;
  referenceEdge: string;
  kinds: Record<string, string>;
};

const GRAPH_THEMES: Record<ThemeName, GraphTheme> = {
  dark: {
    grid: "#314152",
    minimap: "#101b25",
    minimapMask: "rgba(12, 18, 24, 0.68)",
    nodeBackground: "#16212c",
    nodeText: "#e5edf5",
    selection: "#b9f3ff",
    referenceEdge: "#718096",
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
    grid: "#cbd5e1",
    minimap: "#eef3f8",
    minimapMask: "rgba(241, 245, 249, 0.7)",
    nodeBackground: "#ffffff",
    nodeText: "#17202b",
    selection: "#0e7490",
    referenceEdge: "#64748b",
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

type ArtifactSetGrouping = {
  memberNodesBySet: Map<string, GraphNode[]>;
  parentSetByArtifact: Map<string, string>;
  containedEdgeIds: Set<string>;
};

function isArtifactCollection(node: GraphNode | undefined): boolean {
  return node?.kind === "artifact_set" || node?.collection_kind === "dataset-snapshot";
}

function artifactSetGrouping(
  nodes: GraphNode[],
  collectionEdges: GraphEdge[],
): ArtifactSetGrouping {
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

function flowNodes(
  graph: GraphPayload | null,
  nodes: GraphNode[],
  theme: GraphTheme,
  selectedNodeId: string | null,
  artifactSets: ArtifactSetGrouping,
): Node[] {
  const columnWidth = 310;
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
  const byKind = new Map<string, number>();
  const byLevel = new Map<number, number>();
  const provenanceByKind = new Map<string, number>();
  const eventCount = nodes.filter(
    (node) => node.layer === "provenance" && node.kind === "event",
  ).length;
  const evidenceCount = nodes.filter(
    (node) => node.layer === "provenance" && node.kind === "evidence",
  ).length;

  const positionFor = (node: GraphNode, slots = 1) => {
    const members = artifactSets.memberNodesBySet.get(node.id);
    const isSelected = node.id === selectedNodeId;
    const isProvenance = node.layer === "provenance";
    const index = byKind.get(node.kind) ?? 0;
    byKind.set(node.kind, index + 1);
    const provenanceColumn =
      node.kind === "artifact" || node.kind === "artifact_set"
        ? -1
        : 1;
    const column = usesDataLayout
      ? isProvenance
        ? provenanceColumn
        : members
          ? Math.min(
              ...members.map((member) => derivationLevels.get(member.id) ?? 0),
            )
          : node.kind === "artifact_set"
          ? -1
          : derivationLevels.get(node.id) ?? 0
      : Object.keys(theme.kinds).indexOf(node.kind);
    const provenanceIndex = provenanceByKind.get(node.kind) ?? 0;
    if (isProvenance) provenanceByKind.set(node.kind, provenanceIndex + 1);
    const dataLevelIndex = byLevel.get(column) ?? 0;
    if (!isProvenance) byLevel.set(column, dataLevelIndex + slots);
    const levelIndex = isProvenance
      ? node.kind === "definition" ||
        node.kind === "artifact" ||
        node.kind === "artifact_set"
        ? -1 - provenanceIndex
        : node.kind === "event"
          ? 1 + provenanceIndex
          : node.kind === "evidence"
            ? 1 + eventCount + provenanceIndex
            : 1 + eventCount + evidenceCount + provenanceIndex
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
    const collectionColor =
      node.collection_kind === "dataset-snapshot"
        ? theme.kinds.artifact
        : theme.kinds.artifact_set;
    return {
      id: node.id,
      parentId: options.parentId,
      extent: options.parentId ? "parent" : undefined,
      position,
      data: {
        label: node.label,
        kind: node.kind,
        collectionKind: node.collection_kind,
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
        boxShadow: isSelected
          ? "0 0 0 2px color-mix(in srgb, " +
            theme.selection +
            " 55%, transparent)"
          : undefined,
        borderRadius: isCollection ? 14 : isArtifact ? 999 : isInvocation ? 0 : 10,
        clipPath: isInvocation
          ? "polygon(12% 0, 88% 0, 100% 50%, 88% 100%, 12% 100%, 0 50%)"
          : undefined,
        color: theme.nodeText,
        fontSize: isCollection ? 11 : 12,
        fontWeight: isCollection ? 700 : undefined,
        lineHeight: 1.35,
        padding: isCollection ? "9px 12px" : isInvocation ? "12px 34px" : isArtifact ? "8px 16px" : 10,
        width: isCollection ? 225 : isInvocation ? 240 : isArtifact ? 185 : 215,
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

  const rendered: Node[] = [];
  const groupedSetNodes = nodes.filter((node) => artifactSets.memberNodesBySet.has(node.id));
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

function flowEdges(
  edges: GraphEdge[],
  theme: GraphTheme,
  containedEdgeIds: Set<string>,
): Edge[] {
  return edges
    .filter(
      (edge) =>
        (edge.relation !== "contains" && edge.relation !== "dataset-partition") ||
        !containedEdgeIds.has(edge.id),
    )
    .map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    animated: edge.relation === "consumes" || edge.relation === "produces",
    markerEnd: { type: MarkerType.ArrowClosed, color: theme.referenceEdge },
    style: {
      stroke:
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
              : theme.referenceEdge,
      strokeDasharray:
        edge.relation === "consumes" ||
        edge.relation === "produces" ||
        edge.relation === "contains" ||
        edge.relation === "dataset-partition"
          ? undefined
          : "5 4",
    },
    }));
}

export default function App() {
  const [graph, setGraph] = useState<GraphPayload | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRun, setSelectedRun] = useState<string>();
  const [selectedInvocation, setSelectedInvocation] = useState<string>();
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());
  const [runFilter, setRunFilter] = useState("");
  const [runStatusFilter, setRunStatusFilter] =
    useState<RunStatusFilter>("all");
  const [selected, setSelected] = useState<RecordPayload | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [isSelectedLoading, setIsSelectedLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [themeName, setThemeName] = useState<ThemeName>("dark");
  const [expandedArtifactSets, setExpandedArtifactSets] = useState<Set<string>>(
    new Set(),
  );
  const flow = useRef<ReactFlowInstance | null>(null);
  const selectedRecordRequest = useRef<AbortController | null>(null);
  const didInitialize = useRef(false);
  const theme = GRAPH_THEMES[themeName];

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
      if (invocation && view !== "run") parameters.set("invocation", invocation);
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

  const loadRuns = useCallback(async (openFirstRun = false) => {
    try {
      const response = await fetch("/api/runs");
      if (!response.ok) throw new Error("CYCLOPS could not list runs.");
      const payload = (await response.json()) as RunsPayload;
      setRuns(payload.runs);
      setExpandedRuns((current) => {
        const available = new Set(payload.runs.map((run) => run.id));
        return new Set([...current].filter((runId) => available.has(runId)));
      });
      if (openFirstRun) {
        const first = payload.runs[0];
        setSelectedRun(first?.id);
        setSelectedInvocation(first?.invocations[0]?.id);
        setExpandedRuns(first ? new Set([first.id]) : new Set());
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
            graph?.view ?? "run",
            selectedRun,
            selectedInvocation,
          ),
        ]);
      }
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      setIsRefreshing(false);
    }
  }, [graph?.view, loadGraph, loadRuns, selectedInvocation, selectedRun]);

  useEffect(() => {
    if (didInitialize.current) return;
    didInitialize.current = true;
    void refreshProject(true);
  }, [refreshProject]);

  const visibleNodes = useMemo(() => {
    if (
      !graph ||
      (graph.view !== "run" &&
        graph.view !== "derivation" &&
        graph.view !== "provenance")
    ) {
      return graph?.nodes ?? [];
    }
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const node of graph.collection_nodes) {
      if (
        graph.collection_edges.some(
          (edge) => edge.target === node.id && expandedArtifactSets.has(edge.source),
        )
      ) {
        nodes.set(node.id, node);
      }
    }
    return [...nodes.values()];
  }, [expandedArtifactSets, graph]);
  const visibleEdges = useMemo(() => {
    if (
      !graph ||
      (graph.view !== "run" &&
        graph.view !== "derivation" &&
        graph.view !== "provenance")
    ) {
      return graph?.edges ?? [];
    }
    return [
      ...graph.edges,
      // Direct collection membership remains visible in the current graph.
      // The detail-panel expansion only adds members outside the selected scope.
      ...graph.collection_edges,
    ];
  }, [graph]);
  const groupedArtifactSets = useMemo(
    () => artifactSetGrouping(visibleNodes, graph?.collection_edges ?? []),
    [graph?.collection_edges, visibleNodes],
  );
  const nodes = useMemo(
    () => flowNodes(graph, visibleNodes, theme, selectedNodeId, groupedArtifactSets),
    [graph, groupedArtifactSets, selectedNodeId, theme, visibleNodes],
  );
  const edges = useMemo(
    () =>
      flowEdges(
        visibleEdges,
        theme,
        groupedArtifactSets.containedEdgeIds,
      ),
    [groupedArtifactSets, theme, visibleEdges],
  );

  useEffect(() => {
    if (!graph) return;
    const animation = requestAnimationFrame(() => {
      flow.current?.fitView({ duration: 260, padding: 0.18 });
    });
    return () => cancelAnimationFrame(animation);
  // A node selection only changes local styling and the detail panel.  It
  // must not refit the viewport: users otherwise lose the graph position they
  // were inspecting.  Refit only after loading a distinct graph scope.
  }, [graph]);

  const clearSelectedRecord = useCallback(() => {
    selectedRecordRequest.current?.abort();
    selectedRecordRequest.current = null;
    setSelectedNodeId(null);
    setSelected(null);
    setIsSelectedLoading(false);
    setCopied(false);
  }, []);

  const selectNode: NodeMouseHandler = useCallback(async (_event, node) => {
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
  }, []);

  useEffect(() => {
    clearSelectedRecord();
  }, [clearSelectedRecord, graph]);

  useEffect(() => () => selectedRecordRequest.current?.abort(), []);

  const toggleSelectedArtifactSet = useCallback(() => {
    if (selected?.record.kind !== "artifact_set") return;
    setExpandedArtifactSets((current) => {
      const next = new Set(current);
      if (next.has(selected.digest)) next.delete(selected.digest);
      else next.add(selected.digest);
      return next;
    });
  }, [selected]);

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

  const selectRun = useCallback((runId: string) => {
    const selected = runId || undefined;
    const run = runs.find((candidate) => candidate.id === selected);
    clearSelectedRecord();
    setSelectedRun(selected);
    setSelectedInvocation(run?.invocations[0]?.id);
    setExpandedRuns((current) => new Set([...current, runId]));
    setExpandedArtifactSets(new Set());
    void loadGraph("run", selected);
  }, [clearSelectedRecord, loadGraph, runs]);

  const selectInvocation = useCallback((runId: string, invocationId: string) => {
    clearSelectedRecord();
    setSelectedRun(runId);
    setSelectedInvocation(invocationId || undefined);
    setExpandedRuns((current) => new Set([...current, runId]));
    setExpandedArtifactSets(new Set());
    void loadGraph(
      graph?.view === "provenance" ? "provenance" : "derivation",
      runId,
      invocationId || undefined,
    );
  }, [clearSelectedRecord, graph?.view, loadGraph]);

  const toggleRun = useCallback((runId: string) => {
    setExpandedRuns((current) => {
      const next = new Set(current);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }, []);

  const filteredRuns = useMemo<FilteredRun[]>(() => {
    const query = runFilter.trim().toLocaleLowerCase();
    return runs.flatMap((run) => {
      const runMatchesQuery = [run.label, run.record_id]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query);
      const hasNestedWork = run.invocations.some((invocation) => invocation.depth > 0);
      const matchingInvocations = run.invocations.filter(
        (invocation) =>
          invocationMatchesStatus(invocation, runStatusFilter) &&
          (!query || runMatchesQuery || invocationMatchesQuery(invocation, query)),
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
  }, [runFilter, runStatusFilter, runs]);
  const hasRunFilter = Boolean(runFilter.trim()) || runStatusFilter !== "all";
  const matchingInvocationCount = useMemo(
    () => filteredRuns.reduce((count, filteredRun) => count + filteredRun.matchingInvocationCount, 0),
    [filteredRuns],
  );

  useEffect(() => {
    if (!hasRunFilter) return;
    setExpandedRuns((current) => {
      const next = new Set(current);
      let changed = false;
      for (const { run } of filteredRuns) {
        if (!next.has(run.id)) {
          next.add(run.id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [filteredRuns, hasRunFilter]);

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
            <div className="view-toggle" role="group" aria-label="Graph view">
              <button
                aria-pressed={graph?.view === "run"}
                className={graph?.view === "run" ? "is-active" : undefined}
                onClick={() => void loadGraph("run", selectedRun)}
              >
              Run graph
              </button>
              <button
                aria-pressed={graph?.view === "derivation"}
                className={graph?.view === "derivation" ? "is-active" : undefined}
                onClick={() => void loadGraph("derivation", selectedRun, selectedInvocation)}
              >
              Data DAG
              </button>
              <button
                aria-pressed={graph?.view === "provenance"}
                className={graph?.view === "provenance" ? "is-active" : undefined}
                onClick={() => void loadGraph("provenance", selectedRun, selectedInvocation)}
              >
              OCLP Provenance
              </button>
            </div>
          </div>
        </div>
      </header>
      {error ? <p className="error">{error}</p> : null}
      <section className="workspace">
        <aside className="run-panel">
          <div className="run-panel-heading">
            <p className="eyebrow">Run explorer</p>
            <div className="run-panel-actions">
              <span>{runs.length} run{runs.length === 1 ? "" : "s"}</span>
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
            </div>
          </div>
          <input
            aria-label="Search runs and invocations"
            onChange={(event) => setRunFilter(event.target.value)}
            placeholder="Search runs and invocations"
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
              {" in "}{filteredRuns.length} run{filteredRuns.length === 1 ? "" : "s"}
            </p>
          ) : null}
          <div className="run-tree" role="tree" aria-label="OCLP runs">
            {filteredRuns.map(({ run, invocations }) => {
              const expanded = expandedRuns.has(run.id);
              return (
                <section className="run-tree-item" key={run.id}>
                  <div className="run-tree-root">
                    <button
                      aria-expanded={expanded}
                      aria-label={(expanded ? "Collapse " : "Expand ") + run.label}
                      className="run-tree-disclosure"
                      onClick={() => toggleRun(run.id)}
                    >
                      {expanded ? "▾" : "▸"}
                    </button>
                    <button
                      aria-current={selectedRun === run.id ? "true" : undefined}
                      className={
                        "run-tree-run" +
                        (selectedRun === run.id && graph?.view === "run"
                          ? " is-active"
                          : "")
                      }
                      onClick={() => selectRun(run.id)}
                      title={run.record_id}
                    >
                      <span>{run.label}</span>
                      <small>
                        {statusSummary(run.status_counts)}
                        {" · "}{run.artifact_count} artifact{run.artifact_count === 1 ? "" : "s"}
                        {timelineSummary(run) ? " · " + timelineSummary(run) : ""}
                      </small>
                    </button>
                  </div>
                  {expanded ? (
                    <div className="run-tree-children" role="group">
                      {invocations.map((invocation) => (
                        <button
                          aria-current={selectedInvocation === invocation.id ? "true" : undefined}
                          className={
                            "run-tree-invocation" +
                            (selectedInvocation === invocation.id && graph?.view !== "run"
                              ? " is-active"
                              : "")
                          }
                          key={invocation.id}
                          onClick={() => selectInvocation(run.id, invocation.id)}
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
                                ? "Root"
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
                  ) : null}
                </section>
              );
            })}
            {filteredRuns.length === 0 ? (
              <p className="run-tree-empty">No matching runs.</p>
            ) : null}
          </div>
        </aside>
        <div className="graph-panel">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onInit={(instance) => {
              flow.current = instance;
            }}
            onNodeClick={selectNode}
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
        <aside className="detail-panel">
          <p className="eyebrow">Selected record</p>
          {selected ? (
            <>
              <h2>{String(selected.record.kind)}</h2>
              <p className="record-id">{String(selected.record.id)}</p>
              {selected.record.kind === "artifact_set" ? (
                <button onClick={toggleSelectedArtifactSet}>
                  {expandedArtifactSets.has(selected.digest)
                    ? "Collapse members"
                    : "Expand members"}
                </button>
              ) : null}
              <button onClick={showLineage}>Show 3-hop lineage</button>
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
              Inspect the selected root Invocation and all explicitly nested
              work in the Run graph. Select an Invocation in the Run explorer
              for that Invocation&apos;s Data DAG or Provenance context. Selecting
              a collection highlights its border while leaving its visible
              members selectable.
            </p>
          )}
          {summary ? <p className="store-root">{summary.root}</p> : null}
        </aside>
      </section>
    </main>
  );
}
