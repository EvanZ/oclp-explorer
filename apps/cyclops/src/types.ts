export type GraphNode = {
  id: string;
  kind: string;
  record_id: string;
  label: string;
  digest: string;
  layer?: "data" | "provenance" | "timeline";
  collection_kind?: "dataset-snapshot";
  /** Read-only presentation metadata derived from Core chronology fields. */
  timeline_at?: string;
  timeline_sequence?: string;
  timeline_end_at?: string;
  timeline_lane?: string;
  timeline_depth?: string;
  /** Presentation role for a direct Timeline data binding. */
  timeline_role?: "input" | "output";
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  relation: string;
  label?: string;
};

export type GraphPayload = {
  view: "run" | "derivation" | "provenance" | "timeline" | "reference";
  nodes: GraphNode[];
  edges: GraphEdge[];
  collection_edges: GraphEdge[];
  collection_nodes: GraphNode[];
};

export type Computation = {
  id: string;
  label: string;
  invocation_count: number;
  artifact_count: number;
  edge_count: number;
};

export type ComputationsPayload = {
  computations: Computation[];
};

export type Diagnostic = {
  code?: string;
  message?: string;
  stage?: string;
  artifact?: {
    id: string;
    digest?: { algorithm: string; value: string };
  };
};

export type RunInvocation = {
  id: string;
  record_id: string;
  label: string;
  depth: number;
  status: string;
  diagnostic: Diagnostic | null;
};

export type Run = {
  id: string;
  record_id: string;
  label: string;
  timeline: {
    kind: "lifecycle" | "generic" | "none";
    requested_at: string | null;
    started_at: string | null;
    completed_at: string | null;
    first_event_at: string | null;
    last_event_at: string | null;
  };
  invocation_count: number;
  artifact_count: number;
  status_counts: Record<string, number>;
  invocations: RunInvocation[];
};

export type RunLineage = {
  id: string;
  label: string;
  root_count: number;
  invocation_count: number;
  artifact_count: number;
  status_counts: Record<string, number>;
  runs: Run[];
};

export type RunsPayload = {
  runs: Run[];
  lineages: RunLineage[];
};

export type Summary = {
  root: string;
  record_count: number;
  node_count: number;
  derivation_edge_count: number;
  reference_edge_count: number;
  legacy_invocation_count: number;
  counts: Record<string, number>;
};

export type RecordPayload = {
  digest: string;
  record: Record<string, unknown>;
};
