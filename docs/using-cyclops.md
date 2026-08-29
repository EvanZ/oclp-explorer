# CYCLOPS: OCLP Project Explorer

CYCLOPS is a read-only local web app for inspecting OCLP graphs. It is
deliberately a consumer of durable OCLP records: it does not import application
logic, create records, or define new protocol semantics.

The internal Python package is oclp_explorer; CYCLOPS is the UI name.

## What it shows

- A searchable, collapsible **Lineage explorer** sidebar, derived from root
  OCLP Invocations. It groups root runs only when an explicit
  produced-Artifact-to-consumed-Artifact handoff connects them. Within each
  lineage, every root retains its own identity and nests child Invocations
  through explicit `parent_invocation` bindings. Selecting the lineage opens
  its combined graph; selecting a root still opens that same connected
  lineage, while selecting an Invocation opens its focused graph. For an
  Invocation claiming the OCLP lifecycle Profile, “newest” means its portable
  `requested_at`; otherwise the fallback is clearly labeled as its first
  recorded Event. A run and lineage are CYCLOPS projections of existing Core
  records, not new OCLP record types.
- An operational status in that browser for each child Invocation. CYCLOPS
  derives `succeeded`, `skipped`, `failed`, or `incomplete` from its latest
  terminal Event. Failed children are red and show the Event's portable OCLP
  Diagnostic (`stage`, `code`, and concise `message`) when present. The root
  displays a child-status roll-up (for example, `15 failed · 70 succeeded`).
  These are CYCLOPS read-model fields, not additions to the OCLP Invocation
  specification: Events establish execution state, while Evidence remains an
  independent contract-evaluation record.
- Lineage-explorer filtering that searches a lineage, root run, or Invocation's stored name and
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
- A default **Run lineage** view: all execution roots connected by explicit
  Artifact or ArtifactSet producer/consumer handoffs, plus each root's complete
  explicit child hierarchy. This is the answer to “what work belongs to this
  run lineage?” It does not cross a boundary merely because two jobs read the
  same unproduced data-lake input. Solid animated edges are data derivation;
  static violet dashed edges are execution hierarchy (`parent → child`). Since
  it intentionally combines both kinds of edge, Run lineage is not called a
  DAG.
- A strict **Data DAG** view for the same connected lineage. It contains only
  direct `Artifact → Invocation → Artifact` bindings—no orchestration,
  Definition, Event, Evidence, or inferred edges. Selecting a child Invocation
  in the sidebar still opens that child’s focused Data DAG when investigation
  rather than the complete lineage is useful.
- Artifact node labels use their own logical IDs. Their input/output-port
  associations remain available in graph data without replacing identity in the
  rendered label.
- CYCLOPS fits the viewport when it loads a different graph scope or expands
  or collapses a collection. Selecting a node or opening its record detail
  keeps the view the user chose.
- Nodes can be repositioned with the mouse for the current browser session and
  graph scope. These are personal presentation choices, never OCLP records.
  In **Timeline**, the horizontal position is pinned to the record's asserted
  time; drag a record only up or down to make that chronology easier to read.
  Data-flow, orchestration, and provenance-context edges float to the nearest
  side of each node as it is moved; collection-containment edges retain their
  fixed container shape.
- **Export GIF** temporarily fits the complete current graph scope into its
  frame, then creates a short looping GIF and immediately restores the
  browser's working viewport. It preserves graph scope, collection expansion,
  and theme; animated Data DAG edges flow behind nodes while provenance edges
  remain static. The browser creates and downloads the GIF locally. Because
  CYCLOPS is read-only, the action never writes an OCLP record or changes the
  store.
- Each graph node has a compact record-type icon as a quick visual cue:
  **File** for an Artifact, **Layers** for an ArtifactSet, **ScrollText** for a
  Definition, **Cog** for an Invocation, **Zap** for an Event, and
  **ShieldCheck** for Evidence. A dataset-snapshot collection uses **Database**
  as a profile-aware refinement of the Artifact icon. The existing node colors,
  border treatments, and shapes remain the primary semantic encoding: Artifact
  nodes are rounded capsules and Invocation nodes are hexagons.
- An ArtifactSet bound directly as an Invocation input or output is part of
  that computation's graph. For legacy output records that lack that binding,
  CYCLOPS falls back to a member/output intersection. The fallback is
  necessarily ambiguous when independent runs publish identical
  content-addressed members, so producers should publish the set itself on a
  named port. Collections start collapsed. A collapsed collection has layered
  backplates, a member count, and an expand chevron so it is visibly distinct
  from an ordinary Artifact. Double-click the collection node,
  or use **Expand members** in its record inspector, to reveal its exact
  member Artifacts inside the containing box; repeat the action to collapse
  them. The direct ArtifactSet-to-Invocation binding remains the Data DAG
  edge. Member visibility is a `contains` overlay, never a fan-out of
  independent input or output edges. An Artifact with overlapping set
  membership remains outside the boxes with its explicit containment links.
- A direct **dataset-snapshot** profile Artifact input is a collection too. It
  starts collapsed and expands by the same double-click or inspector control
  to show the exact partition Artifacts declared in its canonical payload.
  This is profile-aware OCLP behavior, not domain-specific inference: CYCLOPS
  reads only integrity-verified dataset-snapshot payloads stored in the
  configured local OCLP store. The snapshot-to-Invocation edge remains the
  direct data binding; partition membership is a contextual overlay.
- **Provenance** is a top-level lightswitch, not a competing main graph mode.
  Toggle it on to layer the currently selected Invocation's Definition,
  implementation source metadata, Evidence, Events, and other non-dataflow
  context over the active Run lineage, Data DAG, or Timeline. The selected
  primary view remains active while the switch is on. A child Invocation's Core
  `parent_invocation` binding remains an execution-hierarchy edge rather than a
  derivation edge.
  It intentionally does not redraw Invocation input/output references or
  Event payload references: the Data DAG's consumed/produced edges are the
  authoritative display of those bindings, while Event payload detail remains
  available in the record inspector. Within the provenance timeline, Events
  are ordered by their Core `occurred_at` and `sequence`; Evidence is ordered
  by its Core `observed_at`. When an Event directly references an Evidence at
  the same time, CYCLOPS places that Evidence immediately after the Event.
  Dashed nodes and edges are provenance context; solid nodes and edges are
  data derivation.
- A **Timeline** view scoped to the same connected Run lineage: time proceeds
  from left to right, with adaptive UTC grid lines (seconds through days). Each
  explicit Invocation has its own lane; its Events and Evidence occupy
  chronological tracks below it. A Definition is non-chronological context, so
  CYCLOPS anchors it directly above its linked Invocation at that Invocation's
  time rather than placing it at an invented earlier position. Direct input and
  output Artifacts and ArtifactSets remain visible: records with immutable
  `created_at` appear at their asserted time, while inputs without it occupy a
  clearly labeled **Untimed inputs** column before the time axis. This retains
  the actual Artifact → Invocation contract without inventing a date.
- Core records and their JSON representation.
- Focused three-hop lineage around a selected record.
- Existing profile-bearing Artifacts, including dataset-snapshot manifests.

For this slice, CYCLOPS maintains two rebuildable local DuckDB databases:

- `<oclp-dir>/catalog.duckdb` is the generic OCLP resolver and Artifact-location
  index. It loads and integrity-verifies canonical records.
- `<oclp-dir>/cyclops.duckdb` is CYCLOPS's navigation read model. Its
  `cyclops_runs`, `cyclops_run_members`, and `cyclops_run_artifacts` tables
  index root runs, their connected lineage groups, explicit Invocation
  hierarchy, and direct Artifact bindings for the sidebar.

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

For the NBA dogfood checkout, use the local restart helper instead of managing
two terminals:

```bash
bash scripts/restart-local.sh
```

It safely stops only an existing `oclp-explorer` API on port 8002 and Vite on
port 5175, then starts both against
`/Users/evanzamir/projects/nba-lineup-model-oclp/data/oclp`. Override that
default with `OCLP_DOGFOOD_DIR=/path/to/data/oclp` when needed. The helper is
explicitly a local dogfood tool: it imports the compatible sibling checkout at
`/Users/evanzamir/projects/oclp-python/src`, or the path supplied through
`OCLP_PYTHON_SOURCE`. This lets it read records that use an unreleased Core
field such as Artifact `created_at`; installed Cyclops releases continue to
use their pinned published SDK. On macOS it uses user-level `launchctl`
services so both processes survive after the script exits. Its logs are in
`${TMPDIR:-/tmp}/cyclops-local/`.

If the viewer needs to infer a relation that should have been explicit in a
record, that is feedback for OCLP rather than a reason to introduce
application-specific UI state.

## Execution status API

`GET /api/runs` is CYCLOPS's normalized, read-only execution view. It returns
both the compatibility `runs` list and `lineages`: connected groups of one or
more root runs joined only by an explicit produced-and-consumed Artifact
handoff. Each child Invocation includes a CYCLOPS-derived `status` and an
optional OCLP `diagnostic` object. CYCLOPS reads those only from the terminal
Event's Core fields; it does not interpret `Evidence.details` or
application-specific Event `data`.

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
