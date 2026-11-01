import json
import os
import time
import urllib.error
import urllib.request

import grpc
import frame_ingress_pb2 as pb
import frame_ingress_pb2_grpc as rpc

base = os.environ["GATEWAY_URL"].rstrip("/")
channel = grpc.insecure_channel(os.environ["GATEWAY_GRPC"])
gateway = rpc.FrameIngressStub(channel)


def request(method, path, body=None, expected=200):
    data = None if body is None else json.dumps(body).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(base + path, data=data, method=method,
                                                          headers={"Content-Type": "application/json"}), timeout=30) as response:
            status, result = response.status, json.load(response)
    except urllib.error.HTTPError as error:
        status, result = error.code, json.load(error)
    assert status == expected, (path, status, result)
    return result.get("data", result)


def send(token, module="can"):
    return gateway.SendFrame(pb.FrameRequest(ver=1, id=1, session=1, ts=int(time.time() * 1000), runtime_id=token,
                                             event=pb.TRACK_EVENT_CONFIRMED, camera_no=1, modules=[module],
                                             dets=[pb.Detection(detection_id=1, cid=0, cls="person", type=1)],
                                             record=pb.Record(code=1, frame_id=42, count=1)), timeout=5)


def switch(token, active):
    current = request("GET", "/runtime")
    stop = {"transition_id": token, "previous_transition_id": current["transition_id"], "action": "stop"}
    assert request("PUT", "/runtime", stop)["state"] == "stopped"
    assert not send(current["transition_id"]).accepted
    package = {"revision": token, "transition_id": token, "active": active,
               "integrations": {"rsm-2000": {"modules": {"websocket": {"enabled": False}, "can": {"enabled": False}}},
                                "iskra": {"modules": {"modbus": {"enabled": False}}}}}
    invalid = json.loads(json.dumps(package))
    invalid["integrations"]["rsm-2000"]["modules"]["websocket"]["heartbeat_sec"] = -1
    request("PUT", "/config", invalid, 422)
    assert request("GET", "/runtime")["revision"] != token
    request("PUT", "/config", package)
    assert request("GET", "/runtime")["state"] == "stopped"
    request("PUT", "/runtime", {"transition_id": token, "revision": "wrong", "action": "start"}, 409)
    request("PUT", "/runtime", {"transition_id": token, "revision": token, "action": "start"})
    request("PUT", "/runtime", stop, 409)
    assert not send("obsolete").accepted
    assert not send("").accepted
    return package


switch("one", "rsm-2000")
assert send("one").accepted
assert request("GET", "/status")["modules"][1]["payload"]["count"] == 1
switch("two", "iskra")
assert send("two", "modbus").accepted
assert request("GET", "/status")["modules"][0]["queue"]["total"] == 1
switch("three", "rsm-2000")
assert request("GET", "/status")["modules"][1]["payload"]["count"] == 0
package = switch("four", "iskra")
assert request("GET", "/status")["modules"][0]["queue"]["total"] == 1
request("PUT", "/config", {**package, "active": "rsm-2000"}, 422)
request("POST", "/integrations/select", {"id": "rsm-2000"}, 404)
request("PUT", "/config/can", {}, 404)
assert request("PUT", "/runtime", {"transition_id": "five", "previous_transition_id": "four", "action": "stop"})["state"] == "stopped"
print("gateway lifecycle-check: OK")
