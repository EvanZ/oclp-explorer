# Using Cyclops

Cyclops is a read-only browser for an OCLP record store. It does not schedule
work, write OCLP records, infer domain meaning, or replace an application’s
artifact store. It turns explicit Core bindings into navigable views.

## Start it

Point the API at the root that contains the Core record-kind directories:

```bash
oclp-explorer --oclp-dir /path/to/data/oclp-0.3
```

Then run the bundled client from `apps/cyclops`:

```bash
npm run dev
```

The API reads an immutable snapshot until the user presses Cyclops’ refresh
button. It maintains a separate, rebuildable `cyclops.duckdb` navigation index
beside the record store. That index is Cyclops metadata, not an OCLP Artifact
or source of truth.

## What Cyclops understands

Core 0.3 makes four relationships explicit:

```text
Computation ─── describes reusable work ───> Execution
Evidence evaluator ─── is required by ───> Computation

Artifact / ArtifactSet ── consumes ──> Execution ── produces ──> Artifact / ArtifactSet

parent Execution ── orchestrates ──> child Execution

Event ── observes ──> Execution
Evidence ── evaluates ──> a subject record
Evidence records its exact evaluator binding directly
```

Cyclops uses those literal relationships. It does not draw a data-flow edge
from an Event to an output Artifact, and it does not derive status from
application-specific Evidence details.

## Views

**Run lineage** is the default. When Executions claim the lifecycle profile's
same `run_id`, Cyclops groups those real Executions as one lifecycle run.
Older stores without that profile field retain the legacy root-Execution and
`parent_execution` hierarchy. Separate lifecycle runs appear in one lineage
only when an explicit data handoff connects them: normally an Artifact or
ArtifactSet one Execution produces and another consumes, or a directly
published ArtifactSet that explicitly claims one lifecycle and is consumed by
another. This keeps shared lake inputs from joining unrelated runs without
inventing a release Execution for a direct collection publication.

Cyclops encloses a run's complete direct materialization—its Executions, direct
input/output Artifacts, ArtifactSets, and Computations—in a read-only
**Lifecycle** boundary with an Activity icon. The boundary is Cyclops
presentation metadata, not an OCLP record; in particular, it does not invent a
controller Execution or an Execution-to-Execution flow edge. Artifact bindings
remain the only causal flow edges. When Provenance is enabled with a lifecycle
run selected, the Events and Evidence for every Execution in that run join the
same boundary. Selecting one Execution narrows that overlay to its local
context.

**Data DAG** shows only the strict `Artifact → Execution → Artifact` (or
ArtifactSet) bindings. It is the best view for direct computation dependencies.

**Timeline** projects the Execution selected in the Lineage explorer onto a
left-to-right UTC axis. Select a lifecycle run to view its whole chronology,
or select one Execution to inspect only that computation's direct inputs,
outputs, Events, and Evidence. An Artifact with Core `created_at` uses that
time; an input without it is displayed in the untimed-input area rather than
assigned a made-up timestamp. A Computation is positioned immediately above
its Execution for readability, while Events and Evidence use their immutable
observation times.

**Provenance** overlays Computations, Events, Evidence, and other non-dataflow
record context on the same Data DAG. With a lifecycle run selected it includes
the context for every Execution in that run; with one Execution selected it
narrows to that computation. It does not replace the Data DAG; it adds the
references required to understand why the work was observed as it was.

## Collections and selection

ArtifactSets and dataset-snapshot Artifacts are collections. Their members are
shown as an expandable inventory group. Expand or collapse one with a
double-click; collapsing a collection never changes its actual consumes or
produces edge. A collapsed collection uses a stacked-node treatment so its
expandability remains visible.

If a member Artifact participates in a visible `consumes` or `produces`
binding, Cyclops keeps that Artifact and its causal edges visible even while
its collection is collapsed. A collection is inventory metadata; it must not
visually sever a Data DAG bridge such as a released model that is also an input
to inference.

Select any node to see its canonical JSON in the detail panel. Selection also
traces the visible causal graph in both directions: blue edges lead to its
prerequisites, and green edges lead to records that depend on it. Click the
selected node again—or the canvas background—to clear selection.

Run lineage, Data DAG, and Provenance use a collision-aware layered layout for
their initial positions. Cyclops measures visible node and collection-box sizes
before arranging them, so siblings do not overlap. You can still drag nodes to
make a temporary local adjustment; choose **Auto-arrange** to replace those
manual positions with a fresh layout. Timeline intentionally does not offer
auto-arrange because each node's horizontal position is pinned to its asserted
time.

## Status and filtering

The run explorer lists Executions in lifecycle chronological order. A lifecycle
profile claim has one `execution-started` Event and may have an
`execution-terminal` Event. Cyclops derives `succeeded`, `failed`, or `skipped`
from the terminal Event’s Core `status`; without one it displays `incomplete`.
The status filters and red failure treatment are Cyclops presentation metadata,
not new fields on an Execution.

## Icons and animation

- **File input/output**: a direct Artifact input or output.
- **Stacked files**: an ArtifactSet.
- **Scroll**: a Computation.
- **Checked badge**: an Evidence evaluator.
- **Gear**: an Execution.
- **Lightning**: an Event.
- **Shield**: Evidence.

Data-DAG edges animate to emphasize artifact flow. Provenance edges stay still
because they are context rather than material flow. The toolbar can export the
current complete graph as an animated GIF.

## Roadmap

### Incremental dynamic-graph projection

Cyclops currently builds its cached snapshot by reading and validating the
complete immutable record store, then rebuilding its local DuckDB navigation
index. That is intentionally the correctness baseline and recovery path.

For larger or continuously updated stores, the planned direction is an
incremental, rebuildable graph projection in Cyclops-owned storage. It will
index Core record UUIDs, explicit reference and derivation edges, lifecycle
membership, ArtifactSet membership, and Event/Evidence timing as newly
observed records arrive. The projection must tolerate out-of-order arrival:
an unresolved reference remains pending until its target record is available.

This does not change OCLP records or make the index authoritative. Immutable
OCLP records remain the source of truth, and Cyclops must always be able to
rebuild the index from them. The index simply lets Cyclops fetch the selected
run, Execution, Artifact, release, or focused neighborhood without parsing an
entire large project on each refresh.

### Optional workflow topology

Cyclops may later display an application-declared static computation topology
alongside runtime lineage. Such a view describes possible Computations and
port bindings before execution; it does not replace the dynamic graph of the
Artifacts, Executions, Events, and Evidence that actually materialized.

A topology would be an additive view. Runtime lineage remains the authoritative
record of data-dependent branching, fan-out, retries, failures, and request
materializations.
