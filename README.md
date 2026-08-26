# Cyclops: OCLP Explorer

Cyclops is a read-only local web application for exploring durable
[Open Computation Lifecycle Protocol](https://github.com/EvanZ/open-computation-lifecycle)
records.

It reads a configured OCLP record store, builds a rebuildable local DuckDB
read model, and presents run-oriented derivation and provenance graphs. It
does not create, mutate, or reinterpret protocol records, and it contains no
application-domain logic.

The Python package is `oclp_explorer`; **Cyclops** is the product and site
name.

## Run locally

Install the backend and point it at an existing OCLP store:

```bash
uv sync --group dev
uv run oclp-explorer --oclp-dir /path/to/data/oclp --port 8002
```

Then, in another terminal:

```bash
cd apps/cyclops
npm install
npm run dev
```

Open <http://127.0.0.1:5175>. The development server proxies API requests to
the local backend on port 8002.

## Development

```bash
uv run pytest
uv run ruff check .
cd apps/cyclops && npm run build
```

Read the [Cyclops guide](docs/using-cyclops.md) for the graph model and local
storage design.
