"""FastAPI service for the read-only CYCLOPS OCLP Project Explorer."""

from __future__ import annotations

import argparse
import platform
import subprocess
from collections.abc import Callable
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Lock

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from oclp_explorer.graph import OclpProjectGraph, load_project_graph
from oclp_explorer.run_index import CyclopsRunIndex


def _open_folder(folder: Path) -> None:
    """Ask the local desktop to reveal one already-resolved directory."""

    commands = {
        "Darwin": ("open", str(folder)),
        "Linux": ("xdg-open", str(folder)),
        "Windows": ("explorer", str(folder)),
    }
    command = commands.get(platform.system())
    if command is None:
        raise RuntimeError("Opening folders is not supported on this platform.")
    try:
        subprocess.Popen(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError as error:
        raise RuntimeError("CYCLOPS could not open the local folder.") from error


def _open_file(path: Path) -> None:
    """Ask the local desktop to open one already-verified local file."""

    commands = {
        "Darwin": ("open", str(path)),
        "Linux": ("xdg-open", str(path)),
        "Windows": ("explorer", str(path)),
    }
    command = commands.get(platform.system())
    if command is None:
        raise RuntimeError("Opening files is not supported on this platform.")
    try:
        subprocess.Popen(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError as error:
        raise RuntimeError("CYCLOPS could not open the verified local image.") from error


def create_app(
    oclp_dir: Path | str = Path("data/oclp"),
    *,
    run_index_path: Path | str | None = None,
    reveal_folder: Callable[[Path], None] = _open_folder,
    open_file: Callable[[Path], None] = _open_file,
) -> FastAPI:
    """Create a CYCLOPS API bound to one explicit local OCLP store."""

    root = Path(oclp_dir)
    run_index_database = (
        Path(run_index_path) if run_index_path is not None else root / "cyclops.duckdb"
    )
    run_index: CyclopsRunIndex | None = None
    cached_graph: OclpProjectGraph | None = None
    catalog_lock = Lock()

    def _rebuild_graph_locked() -> OclpProjectGraph:
        """Build the one immutable project snapshot served until manual refresh."""

        nonlocal cached_graph, run_index
        if run_index is None:
            run_index = CyclopsRunIndex(run_index_database)
        # The producer owns catalog.duckdb. DuckDB permits either a writer or
        # readers from other processes, never both; CYCLOPS instead projects
        # the canonical record files and keeps its read model separately.
        cached_graph = load_project_graph(root)
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
        nonlocal cached_graph, run_index
        try:
            yield
        finally:
            with catalog_lock:
                if run_index is not None:
                    run_index.close()
                    run_index = None
                cached_graph = None

    app = FastAPI(
        title="CYCLOPS — OCLP Project Explorer",
        version="0.2.0-draft",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5175", "http://127.0.0.1:5175"],
        allow_methods=["GET", "POST"],
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
        """List runs and their connected lineage groups."""

        graph()
        with catalog_lock:
            assert run_index is not None
            return run_index.runs_payload()

    @app.get("/api/graph")
    def project_graph(
        view: str = Query(
            default="derivation", pattern="^(run|derivation|provenance|timeline|reference)$"
        ),
        component: str | None = None,
        run: str | None = None,
        execution: str | None = None,
        service: str | None = None,
        lineage: bool = False,
    ) -> dict[str, object]:
        return graph().graph_payload(
            view=view,
            component=component,
            run=run,
            execution=execution,
            service=service,
            lineage=lineage,
        )

    @app.get("/api/records/{record_id}")
    def record(record_id: str) -> dict[str, object]:
        try:
            return graph().record_payload(record_id)
        except KeyError as error:
            raise HTTPException(
                status_code=404, detail=f"Unknown record ID: {record_id}"
            ) from error

    @app.get("/api/records/{record_id}/image")
    def image_payload(record_id: str) -> FileResponse:
        """Serve one verified local raster Artifact for an in-app preview."""

        try:
            project_graph = graph()
            path = project_graph.local_raster_image_payload_path(record_id)
            if path is None:
                raise FileNotFoundError(
                    "This record has no verified local raster image payload."
                )
            media_type = project_graph.records[record_id].media_type
            return FileResponse(
                path,
                media_type=media_type,
                headers={
                    "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff",
                },
            )
        except KeyError as error:
            raise HTTPException(
                status_code=404, detail=f"Unknown record ID: {record_id}"
            ) from error
        except FileNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.post("/api/records/{record_id}/image/open")
    def open_image_payload(record_id: str) -> dict[str, str]:
        """Open one verified local Artifact image in the system default app."""

        try:
            path = graph().local_image_payload_path(record_id)
            if path is None:
                raise FileNotFoundError(
                    "This record has no verified local image payload."
                )
            open_file(path)
            return {"path": str(path)}
        except KeyError as error:
            raise HTTPException(
                status_code=404, detail=f"Unknown record ID: {record_id}"
            ) from error
        except FileNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except RuntimeError as error:
            raise HTTPException(status_code=501, detail=str(error)) from error

    @app.post("/api/records/{record_id}/reveal")
    def reveal_record_folder(
        record_id: str,
        target: str = Query(default="record", pattern="^(record|payload)$"),
    ) -> dict[str, str]:
        """Reveal a selected record's canonical JSON or local payload folder."""

        try:
            project_graph = graph()
            if target == "record":
                folder = project_graph.record_path(record_id).parent
            else:
                payload_path = project_graph.local_artifact_payload_path(record_id)
                if payload_path is None:
                    raise FileNotFoundError(
                        "This record has no available local Artifact payload."
                    )
                folder = payload_path.parent
            reveal_folder(folder)
            return {"target": target, "folder": str(folder)}
        except KeyError as error:
            raise HTTPException(
                status_code=404, detail=f"Unknown record ID: {record_id}"
            ) from error
        except FileNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except RuntimeError as error:
            raise HTTPException(status_code=501, detail=str(error)) from error

    @app.get("/api/lineage/{record_id}")
    def lineage(
        record_id: str,
        depth: int = Query(default=2, ge=0, le=6),
        view: str = Query(
            default="derivation", pattern="^(run|derivation|provenance|timeline|reference)$"
        ),
        component: str | None = None,
        run: str | None = None,
        execution: str | None = None,
    ) -> dict[str, object]:
        try:
            return graph().focused_payload(
                record_id,
                depth=depth,
                view=view,
                component=component,
                run=run,
                execution=execution,
            )
        except KeyError as error:
            raise HTTPException(
                status_code=404, detail=f"Unknown record ID: {record_id}"
            ) from error

    return app


app = create_app()


def main() -> None:
    """Run CYCLOPS locally against one OCLP project store."""

    parser = argparse.ArgumentParser(description="Run CYCLOPS, the OCLP Project Explorer")
    parser.add_argument("--oclp-dir", type=Path, default=Path("data/oclp"))
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
            run_index_path=arguments.run_index_path,
        ),
        host="127.0.0.1",
        port=arguments.port,
    )


if __name__ == "__main__":
    main()
