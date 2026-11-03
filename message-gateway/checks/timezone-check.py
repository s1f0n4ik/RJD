import json
import os
from pathlib import Path
import urllib.error
import urllib.request

base = os.environ.get("GATEWAY_URL", "http://127.0.0.1:19090").rstrip("/")


def request(method, path, body=None, expected=200):
    data = None if body is None else json.dumps(body).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(base + path, data=data, method=method,
                                                          headers={"Content-Type": "application/json"}), timeout=10) as response:
            status, value = response.status, json.load(response)
    except urllib.error.HTTPError as error:
        status, value = error.code, json.load(error)
    assert status == expected, (path, status, value)
    return value.get("data", value)


current = request("GET", "/runtime")
token = "timezone-check"
request("PUT", "/runtime", {"transition_id": token, "previous_transition_id": current["transition_id"], "action": "stop"})
package = {"revision": "zone-300", "transition_id": token, "active": "rsm-2000",
           "integrations": {"rsm-2000": {"modules": {"websocket": {"enabled": False}, "can": {"enabled": False}}},
                            "iskra": {"modules": {"modbus": {"enabled": False}}}}, "time": {"tz_offset_min": 300}}
request("PUT", "/config", package)
assert request("GET", "/time")["tz_offset_min"] == 300
assert request("GET", "/runtime")["state"] == "stopped"
for value in [-721, 841, 0.5, True, "180", 18446744073709551615]:
    request("PUT", "/config", {**package, "revision": "invalid", "time": {"tz_offset_min": value}}, 422)
    assert request("GET", "/time")["tz_offset_min"] == 300
    assert request("GET", "/runtime")["revision"] == "zone-300"
validated = request("POST", "/config/validate", {**package, "time": {"tz_offset_min": 420}})
assert validated["time"]["tz_offset_min"] == 420
assert request("GET", "/time")["tz_offset_min"] == 300
request("PUT", "/runtime", {"transition_id": token, "revision": "zone-300", "action": "start"})
request("PUT", "/config", {**package, "revision": "zone-420", "time": {"tz_offset_min": 420}})
assert request("GET", "/time")["tz_offset_min"] == 420
assert request("GET", "/runtime")["state"] == "running"
request("PUT", "/config/time", {"tz_offset_min": 180}, 404)
request("PUT", "/config", {key: value for key, value in {**package, "revision": "zone-default"}.items() if key != "time"})
assert request("GET", "/time")["tz_offset_min"] == 180
if os.environ.get("GATEWAY_STATE"):
    saved = json.loads(Path(os.environ["GATEWAY_STATE"]).read_text(encoding="utf-8"))
    assert saved["time"]["tz_offset_min"] == 180 and saved["config_revision"] == "zone-default"
request("PUT", "/runtime", {"transition_id": "timezone-finished", "previous_transition_id": token, "action": "stop"})
print("gateway timezone-check: OK")
