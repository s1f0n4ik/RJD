import json
import os
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.config import settings

router = APIRouter(prefix="/tests", tags=["Tests"])


def reports_root() -> Path:
    return Path(os.environ.get("TEST_RESULTS_DIR", str(Path(settings.CONFIG_DB).parent / "test-reports")))


def run_path(run_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,95}", run_id):
        raise HTTPException(404, "Unknown test run")
    root = reports_root().resolve()
    target = (root / run_id).resolve()
    if not target.is_relative_to(root) or not target.is_dir():
        raise HTTPException(404, "Unknown test run")
    return target


def read_report(path: Path) -> dict:
    try:
        report = json.loads((path / "report.json").read_text(encoding="utf-8"))
        if not isinstance(report, dict) or report.get("id") != path.name or report.get("schema_version") != 1:
            raise ValueError("Invalid report schema")
        return report
    except FileNotFoundError:
        raise HTTPException(404, "Test report is not available")
    except (ValueError, OSError):
        raise HTTPException(500, "Cannot read test report")


@router.get("/runs")
def list_runs():
    root = reports_root()
    result, unreadable = [], 0
    if root.is_dir():
        for path in root.iterdir():
            if not path.is_dir() or path.is_symlink():
                continue
            try:
                report = read_report(path)
                counts = {state: sum(check.get("status") == state for check in report.get("checks", []))
                          for state in ("passed", "failed", "blocked", "skipped")}
                result.append({key: report.get(key) for key in ("id", "started_at", "finished_at", "state", "phase", "progress", "target")} | {"counts": counts})
            except HTTPException:
                unreadable += 1
    return {"runs": sorted(result, key=lambda item: item.get("started_at") or "", reverse=True), "unreadable": unreadable}


@router.get("/runs/{run_id}")
def get_run(run_id: str):
    return read_report(run_path(run_id))


@router.get("/runs/{run_id}/artifacts/{name}")
def get_artifact(run_id: str, name: str):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", name):
        raise HTTPException(404, "Unknown test artifact")
    directory = run_path(run_id)
    report = read_report(directory)
    if name not in {item.get("name") for item in report.get("artifacts", [])}:
        raise HTTPException(404, "Unknown test artifact")
    target = (directory / name).resolve()
    if not target.is_relative_to(directory) or not target.is_file():
        raise HTTPException(404, "Unknown test artifact")
    return FileResponse(target, filename=name, media_type="application/octet-stream")
