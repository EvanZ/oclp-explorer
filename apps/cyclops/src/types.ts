export type GraphNode = {
  id: string;
  kind: string;
  record_id: string;
  label: string;
  /** Canonical JSON hash supplied for catalog integrity/debugging only. */
  record_digest?: string;
  layer?: "data" | "provenance" | "timeline";
  collection_kind?: "dataset-snapshot";
  /** Core Artifact media type, supplied separately for semantic icon choice. */
  media_type?: string;
  /** Read-only presentation metadata derived from Core chronology fields. */
  timeline_at?: string;
  timeline_sequence?: string;
  timeline_end_at?: string;
  timeline_lane?: string;
  timeline_depth?: string;
  /** Evidence outcome, when this node represents an Evidence record. */
  outcome?: "pass" | "fail" | "error";
  /** Terminal execution status, projected on Execution and terminal Event nodes. */
  status?: "succeeded" | "failed" | "skipped" | "incomplete";
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

/**
 * A read-only CYCLOPS presentation boundary for an explicit Execution
 * hierarchy. It is deliberately not an OCLP record or graph relation.
 */
export type LifecycleGroup = {
  id: string;
  root_id: string;
  /** Presentation-only boundary title; it never creates a Core relation. */
  title?: "Run" | "Lineage" | "Inference service";
  label: string;
  member_ids: string[];
};

export type GraphPayload = {
  view: "run" | "derivation" | "provenance" | "timeline" | "reference";
  nodes: GraphNode[];
  edges: GraphEdge[];
  collection_edges: GraphEdge[];
  collection_nodes: GraphNode[];
  lifecycle_groups: LifecycleGroup[];
  /** CYCLOPS-only collapsed view of real request Executions for one release. */
  inference_services: InferenceService[];
};

export type Computation = {
  id: string;
  label: string;
  execution_count: number;
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

export type RunExecution = {
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
    kind: "run" | "generic" | "none";
    started_at: string | null;
    completed_at: string | null;
    first_event_at: string | null;
    last_event_at: string | null;
  };
  execution_count: number;
  artifact_count: number;
  status_counts: Record<string, number>;
  executions: RunExecution[];
};

export type InferenceServiceRequest = RunExecution & {
  /** The real request-scoped run that owns this immutable Execution. */
  run_id: string;
};

export type InferenceService = {
  /** Presentation ID; this is intentionally not an OCLP record ID. */
  id: string;
  release_record_id: string;
  label: string;
  model_record_id?: string;
  source_node_id?: string | null;
  request_count: number;
  status_counts: Record<string, number>;
  timeline: Run["timeline"];
  execution_ids?: string[];
  hidden_node_ids?: string[];
  requests?: InferenceServiceRequest[];
};

export type RunLineage = {
  id: string;
  label: string;
  run_count: number;
  execution_count: number;
  artifact_count: number;
  status_counts: Record<string, number>;
  runs: Run[];
  inference_services: InferenceService[];
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
  incomplete_execution_count: number;
  counts: Record<string, number>;
};

export type RecordPayload = {
  id: string;
  record_digest: string;
  record: Record<string, unknown>;
};
