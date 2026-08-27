# Tour Cyclops

Cyclops reads an existing local OCLP store and projects its immutable records
into a navigable run graph. The images below use a small generic customer-data
refresh: one nested task succeeds, one fails, and the successful task publishes
a named release.

## Start from the run

The Run explorer is the starting point. It groups explicitly nested Invocations
under the root Invocation that represents the run. The default **Run graph**
shows the hierarchy alongside the direct Artifacts that each task consumed or
published. Solid animated edges carry data; violet dashed edges show execution
hierarchy.

![Cyclops run explorer showing a customer-data refresh with nested tasks and a release ArtifactSet](images/run-explorer.png)

An ArtifactSet starts as one collapsed collection node. Its layered backplates,
member count, and expand chevron make the hidden members visible as a concept
without showing them individually. Double-click it to reveal its unshared
member Artifacts inside a containing box, and double-click again to collapse
them. It organizes a published collection without replacing the underlying
Artifact records or adding a new execution step.

Use **Export GIF** in the toolbar to download a short loop of the current
viewport. It is useful for explaining a run in a document or issue without
making the read-only explorer mutate the OCLP store.

## Inspect the durable record

Select any node to inspect the immutable OCLP JSON that Cyclops read from the
local store. The detail panel keeps the record's kind and ID visible, exposes a
focused lineage view, and provides a **Copy JSON** action for troubleshooting,
tests, or downstream tooling.

![Cyclops showing a selected normalized-customer-orders Artifact and its immutable JSON record](images/record-inspector.png)

## Add provenance when needed

Select a task in the Run explorer, then choose **OCLP Provenance**. The data
nodes stay in place while Cyclops adds the Definition, Events, Evidence, and
other non-dataflow context recorded for that Invocation.

![Cyclops provenance view showing a definition, successful invocation, artifacts, events, and evidence](images/provenance.png)

Here is the same idea in an exported dogfood provenance graph. The bright,
flowing edges are direct Data DAG bindings; the quiet dashed edges add
Definition, Event, and Evidence context without claiming those records are
inputs or outputs of the computation.

![Animated Cyclops provenance flow for a 2025-26 RAPM baseline training invocation](images/provenance-flow.gif)

The provenance overlay is deliberately scoped to the selected Invocation. Use
the Run graph to return to the broader parent-and-child view.

## Find work that needs attention

Use the search box or status filters in the Run explorer to narrow its
navigation tree. A failed Invocation is shown in red, with the portable OCLP
Diagnostic from its terminal Event beneath its label. The graph itself remains
the selected run; filtering never changes OCLP records or silently discards
their context.

![Cyclops Run explorer filtered to one failed enrichment invocation](images/failed-run-filter.png)

See [Using Cyclops](using-cyclops.md) for the local startup command, graph
semantics, refresh behavior, and API details.
