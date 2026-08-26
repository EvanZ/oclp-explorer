"""FastAPI service for the read-only CYCLOPS OCLP Project Explorer."""

from __future__ import annotations

import argparse
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Lock

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from oclp.catalog.duckdb import DuckdbCatalog

from oclp_explorer.graph import OclpProjectGraph, load_project_graph
from oclp_explorer.run_index import CyclopsRunIndex


def create_app(
    oclp_dir: Path | str = Path("data/oclp"),
    *,
    catalog_path: Path | str | None = None,
    run_index_path: Path | str | None = None,
) -> FastAPI:
    """Create a CYCLOPS API bound to one explicit local OCLP store."""

    root = Path(oclp_dir)
    database = Path(catalog_path) if catalog_path is not None else root / "catalog.duckdb"
    run_index_database = (
        Path(run_index_path) if run_index_path is not None else root / "cyclops.duckdb"
    )
    catalog: DuckdbCatalog | None = None
    run_index: CyclopsRunIndex | None = None
    cached_graph: OclpProjectGraph | None = None
    catalog_lock = Lock()

    def _rebuild_graph_locked() -> OclpProjectGraph:
        """Build the one immutable project snapshot served until manual refresh."""

        nonlocal catalog, cached_graph, run_index
        if catalog is None:
            catalog = DuckdbCatalog(database)
        if run_index is None:
            run_index = CyclopsRunIndex(run_index_database)
        cached_graph = load_project_graph(root, catalog=catalog)
        run_index.rebuild(cached_graph)
        return cached_graph

    def graph() -> OclpProjectGraph:
        """Return the current cached snapshot, constructing it once if needed."""

        nonlocal cached_graph
        with catalog_lock:
            try:
                return cached_graph or _rebuild_graph_locked()
            except ValueError as error:
                raise HTTPException(status_code=404, detail=str(error)) from error

    def refresh_graph() -> OclpProjectGraph:
        """Explicitly replace the cached snapshot from immutable OCLP records."""

        with catalog_lock:
            try:
                return _rebuild_graph_locked()
            except ValueError as error:
                raise HTTPException(status_code=404, detail=str(error)) from error

    def health_payload(project_graph: OclpProjectGraph) -> dict[str, object]:
        with catalog_lock:
            assert run_index is not None
            return {
                "status": "ok",
                **project_graph.summary(),
                "run_index": run_index.summary(),
            }

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        nonlocal cached_graph, catalog, run_index
        try:
            yield
        finally:
            with catalog_lock:
                if catalog is not None:
                    catalog.close()
                    catalog = None
                if run_index is not None:
                    run_index.close()
                    run_index = None
                cached_graph = None

    app = FastAPI(
        title="CYCLOPS — OCLP Project Explorer",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5175", "http://127.0.0.1:5175"],
        allow_methods=["GET"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    def health(refresh: bool = False) -> dict[str, object]:
        """Return health for the cached snapshot, rebuilding only on request."""

        return health_payload(refresh_graph() if refresh else graph())

    @app.get("/api/computations")
    def computations() -> dict[str, object]:
        return graph().computations_payload()

    @app.get("/api/runs")
    def runs() -> dict[str, object]:
        """List root Invocation runs for the run-oriented CYCLOPS selector."""

        graph()
        with catalog_lock:
            assert run_index is not None
            return run_index.runs_payload()

    @app.get("/api/graph")
    def project_graph(
        view: str = Query(
            default="derivation", pattern="^(run|derivation|provenance|reference)$"
        ),
        component: str | None = None,
        run: str | None = None,
        invocation: str | None = None,
    ) -> dict[str, object]:
        return graph().graph_payload(
            view=view,
            component=component,
            run=run,
            invocation=invocation,
        )

    @app.get("/api/records/{digest}")
    def record(digest: str) -> dict[str, object]:
        try:
            return graph().record_payload(digest)
        except KeyError as error:
            raise HTTPException(
                status_code=404, detail=f"Unknown record digest: {digest}"
            ) from error

    @app.get("/api/lineage/{digest}")
    def lineage(
        digest: str,
        depth: int = Query(default=2, ge=0, le=6),
        view: str = Query(
            default="derivation", pattern="^(run|derivation|provenance|reference)$"
        ),
        component: str | None = None,
        run: str | None = None,
        invocation: str | None = None,
    ) -> dict[str, object]:
        try:
            return graph().focused_payload(
                digest,
                depth=depth,
                view=view,
                component=component,
                run=run,
                invocation=invocation,
            )
        except KeyError as error:
            raise HTTPException(
                status_code=404, detail=f"Unknown record digest: {digest}"
            ) from error

    return app


app = create_app()


def main() -> None:
    """Run CYCLOPS locally against one OCLP project store."""

    parser = argparse.ArgumentParser(description="Run CYCLOPS, the OCLP Project Explorer")
    parser.add_argument("--oclp-dir", type=Path, default=Path("data/oclp"))
    parser.add_argument(
        "--catalog-path",
        type=Path,
        help="DuckDB catalog path (default: <oclp-dir>/catalog.duckdb)",
    )
    parser.add_argument(
        "--run-index-path",
        type=Path,
        help="CYCLOPS run-index path (default: <oclp-dir>/cyclops.duckdb)",
    )
    parser.add_argument("--port", type=int, default=8002)
    arguments = parser.parse_args()
    import uvicorn

    uvicorn.run(
        create_app(
            arguments.oclp_dir,
            catalog_path=arguments.catalog_path,
            run_index_path=arguments.run_index_path,
        ),
        host="127.0.0.1",
        port=arguments.port,
    )


if __name__ == "__main__":
    main()
