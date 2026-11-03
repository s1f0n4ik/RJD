import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
with tempfile.TemporaryDirectory(prefix="test-report-check-") as directory:
    root = Path(directory)
    os.environ["TEST_RESULTS_DIR"] = directory
    os.environ["DEBUG"] = "false"
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.routers.tests import router

    app = FastAPI()
    app.include_router(router, prefix="/api")
    client = TestClient(app)
    assert client.get("/api/tests/runs").json() == {"runs": [], "unreadable": 0}
    run = root / "run-one"
    run.mkdir()
    report = {"id": run.name, "schema_version": 1, "started_at": "2026-11-01T12:00:00Z", "state": "completed",
              "checks": [{"status": "passed"}, {"status": "failed"}, {"status": "blocked"}],
              "artifacts": [{"name": "segments.json", "label": "Segments"}]}
    (run / "report.json").write_text(json.dumps(report))
    (run / "segments.json").write_text('{"closed": 3}')
    (run / "private.txt").write_text("not published")
    assert client.get("/api/tests/runs").json()["runs"][0]["counts"] == {"passed": 1, "failed": 1, "blocked": 1, "skipped": 0}
    assert client.get("/api/tests/runs/run-one").json() == report
    assert client.get("/api/tests/runs/run-one/artifacts/segments.json").json() == {"closed": 3}
    for url in ("/api/tests/runs/unknown", "/api/tests/runs/run-one/artifacts/private.txt",
                "/api/tests/runs/run-one/artifacts/%2e%2e%2fprivate.txt"):
        assert client.get(url).status_code == 404
    (run / "report.json").write_text("broken")
    assert client.get("/api/tests/runs").json()["unreadable"] == 1
    assert client.get("/api/tests/runs/run-one").status_code == 500
    print("test-report-check: OK")
