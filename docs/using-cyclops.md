# CYCLOPS: OCLP Project Explorer

CYCLOPS is a read-only local web app for inspecting OCLP graphs. It is
deliberately a consumer of durable OCLP records: it does not import application
logic, create records, or define new protocol semantics.

The internal Python package is oclp_explorer; CYCLOPS is the UI name.

## What it shows

- A searchable, collapsible **Run explorer** sidebar, derived from root OCLP
  Invocations. It opens the newest root Invocation by default and nests child
  Invocations through their explicit `parent_invocation` bindings. For an
  Invocation claiming the OCLP lifecycle Profile, “newest” means its portable
  `requested_at`; otherwise the fallback is clearly labeled as its first
  recorded Event. Selecting a run opens its combined graph; selecting an
  Invocation opens that Invocation's focused graph. A run is an explorer
  projection of existing Core records, not a new OCLP record type.
- An operational status in that browser for each child Invocation. CYCLOPS
  derives `succeeded`, `skipped`, `failed`, or `incomplete` from its latest
  terminal Event. Failed children are red and show the Event's portable OCLP
  Diagnostic (`stage`, `code`, and concise `message`) when present. The root
  displays a child-status roll-up (for example, `15 failed · 70 succeeded`).
  These are CYCLOPS read-model fields, not additions to the OCLP Invocation
  specification: Events establish execution state, while Evidence remains an
  independent contract-evaluation record.
- Run-explorer filtering that searches a run or Invocation's stored name and
  ID, execution status, and portable Diagnostic fields. Its **Needs
  attention**, **Failed**, and **Succeeded** filters operate on CYCLOPS's
  generic derived Invocation status, not on application-specific Evidence.
  A matching child keeps its root Invocation visible for context; filtering
  only narrows the navigation tree until the user selects a result.
- Every node label leads with that record's own compact ID. Callable locators,
  event types, outcomes, and timestamps are secondary context rather than a
  substitute identity. Code identity remains in the Provenance overlay's
  Definition, including its Git source revision, while the attempt-started
  Event records the local checkout observed for that run rather than cluttering
  the Data DAG Invocation node.
- Profile-claiming Invocation nodes display `requested <time>`. Records that
  do not claim the lifecycle Profile display `first event <time>` only when an
  Event exists; CYCLOPS never presents that generic fallback as a request or
  completion time.
- A default **Run graph**: the root Invocation, its directly nested child
  Invocations, and the direct consumed/produced Artifact bindings for every
  Invocation in that run. Solid animated edges are data derivation; the static
  violet dashed edges are execution hierarchy (`parent → child`).
- An **Invocation graph** selector. Choosing the root flow or a child task
  immediately opens that Invocation's **Data DAG**, without letting shared
  artifacts pull in unrelated computations. The **Run graph** toggle returns
  to the complete parent-and-child view.
- Artifact node labels use their own logical IDs. Their input/output-port
  associations remain available in graph data without replacing identity in the
  rendered label.
- CYCLOPS fits the viewport when it loads a different graph scope, not when a
  user selects a node, opens record detail, changes its selection styling, or
  expands an ArtifactSet. Navigation therefore keeps the view the user chose.
- Artifact nodes are rounded capsules and Invocation nodes are hexagons. The
  shapes communicate their roles without repeating record-kind text in labels.
- ArtifactSets that an Invocation binds directly in its `outputs` are part of
  that computation's graph. For legacy records that lack that binding,
  CYCLOPS falls back to a member/output intersection. The fallback is
  necessarily ambiguous when independent runs publish identical
  content-addressed members, so producers should publish the set itself on a
  named output port. When the visible members belong to only one visible set,
  CYCLOPS renders that ArtifactSet as a containing box rather than separate
  membership arrows. An Artifact with overlapping set membership remains
  outside the boxes with its explicit containment links, while each set's
  unshared members stay grouped. Expanding a set adds any additional named
  members.
- A direct **dataset-snapshot** profile Artifact input is rendered as a green
  container around the exact partition Artifacts declared in its canonical
  payload. This is profile-aware OCLP behavior, not domain-specific inference:
  CYCLOPS reads only integrity-verified dataset-snapshot payloads stored in the
  configured local OCLP store. The snapshot-to-Invocation edge remains the
  direct data binding; partition membership is a contextual overlay. Selecting
  a dataset or ArtifactSet highlights only its container and never hides or
  intercepts its member nodes.
- An **OCLP Provenance** overlay scoped to the selected Invocation: it keeps
  that Data DAG's Artifact and Invocation nodes in place, then adds Definition,
  implementation source metadata, Evidence, Events, and other non-dataflow
  context. A child Invocation's Core `parent_invocation` binding remains an
  execution-hierarchy edge rather than a derivation edge. Selecting the parent
  flow in the Run graph is how to see the complete parent-and-child run.
  It intentionally does not redraw Invocation input/output references or
  Event payload references: the Data DAG's consumed/produced edges are the
  authoritative display of those bindings, while Event payload detail remains
  available in the record inspector. Dashed nodes and edges are provenance
  context; solid nodes and edges are data derivation.
- Core records and their JSON representation.
- Focused three-hop lineage around a selected record.
- Existing profile-bearing Artifacts, including dataset-snapshot manifests.

For this slice, CYCLOPS maintains two rebuildable local DuckDB databases:

- `<oclp-dir>/catalog.duckdb` is the generic OCLP resolver and Artifact-location
  index. It loads and integrity-verifies canonical records.
- `<oclp-dir>/cyclops.duckdb` is CYCLOPS's navigation read model. Its
  `cyclops_runs`, `cyclops_run_members`, and `cyclops_run_artifacts` tables
  index root runs, explicit Invocation hierarchy, and direct Artifact bindings
  for the sidebar.

The canonical JSON records remain the immutable source of truth. Both databases
are safe to delete and rebuild; neither is a second protocol store. CYCLOPS has
no authentication, write API, or scheduler integration.

The API holds one in-memory snapshot and local run index, then serves all
graph, run, and record navigation from that snapshot. CYCLOPS builds or
replaces it only on an explicit manual refresh: initial page load, browser
reload, or the explorer's refresh button. Once CYCLOPS is started against a
configured store, a producer can publish additional records without restarting
either server. Use the explorer's refresh button to replace its in-memory
snapshot. Restart the API only when changing its code or configured store.

Two nodes with the same computation name are still distinct Invocations: their
time, inputs, parent, and bound Definition can differ. Selecting one exposes
its complete immutable OCLP record in the detail panel.

## Run locally

Start the API from the repository root:

    uv run oclp-explorer --oclp-dir /path/to/data/oclp --port 8002

Then start the frontend:

    cd apps/cyclops
    npm install
    npm run dev

Open <http://127.0.0.1:5175>. Vite proxies requests to the API on port 8002.
Pass `--catalog-path path/to/catalog.duckdb` or
`--run-index-path path/to/cyclops.duckdb` to keep either local index outside
the OCLP record directory.

If the viewer needs to infer a relation that should have been explicit in a
record, that is feedback for OCLP rather than a reason to introduce
application-specific UI state.

## Execution status API

`GET /api/runs` is CYCLOPS's normalized, read-only execution view. Each child
Invocation includes a CYCLOPS-derived `status` and an optional OCLP
`diagnostic` object. CYCLOPS reads those only from the terminal Event's Core
fields; it does not interpret `Evidence.details` or application-specific Event
`data`.

```json
{
  "status": "failed",
  "diagnostic": {
    "stage": "preflight",
    "code": "process:preflight:GameSourceError",
    "message": "Required raw input is unavailable"
  }
}
```

For an Invocation claiming the lifecycle Profile, CYCLOPS takes status from its
`invocation-terminal` Event's Core `status` field. Older records retain a
narrow compatibility mapping for `invocation-completed` and
`invocation-failed`; they do not gain a diagnostic by parsing historical
Evidence detail. Future adapters can map a legacy producer's explicit
conventions into this same API shape without changing the OCLP records.
