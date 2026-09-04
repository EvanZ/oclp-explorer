# Cyclops: OCLP Explorer

Cyclops is a read-only local web application for exploring durable
[Open Computation Lifecycle Protocol](https://github.com/EvanZ/open-computation-lifecycle)
records.

It reads a configured OCLP record store, builds a rebuildable local DuckDB
read model, and presents run lineage, strict Data DAG, chronological timeline,
and record-level provenance context. It
does not create, mutate, or reinterpret protocol records, and it contains no
application-domain logic.

The Python package is `oclp_explorer`; **Cyclops** is the product and site
name.

## Run locally

Install the backend and point it at an existing OCLP store:

```bash
uv sync --group dev
uv run oclp-explorer --oclp-dir /path/to/data/oclp-0.3 --port 8002
```

Then, in another terminal:

```bash
cd apps/cyclops
npm install
npm run dev
```

Open <http://127.0.0.1:5175>. The development server proxies API requests to
the local backend on port 8002.

For the current bike-demand dogfood store, one command safely restarts both
local services:

```bash
bash scripts/restart-local.sh
```

It expects the store at
`/Users/evanzamir/projects/oclp-python/examples/bike-demand-service/data/oclp-0.3`. Set
`OCLP_DOGFOOD_DIR` to use another local OCLP store, and
`OCLP_PYTHON_SOURCE` to use a compatible local `oclp-python/src` checkout.
The script refuses to stop an unrelated process that happens to be listening
on either Cyclops port.

## Development

```bash
uv run pytest
uv run ruff check .
cd apps/cyclops && npm run build
```

Read the [Cyclops guide](docs/using-cyclops.md) for the graph model, local
storage design, and roadmap.
