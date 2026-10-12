# Отправитель записей в шлюз: строка JSON на stdin -> SendFrame -> строка JSON на stdout
import argparse
import json
import os
import sys
import time

from grpc_tools import protoc

STUBS = "/tmp/mbstand-stubs"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--grpc", default="127.0.0.1:15051")
    parser.add_argument("--proto", default="/proto")
    args = parser.parse_args()

    os.makedirs(STUBS, exist_ok=True)
    if protoc.main(["protoc", f"-I{args.proto}", f"--python_out={STUBS}", f"--grpc_python_out={STUBS}", "frame-ingress.proto"]) != 0:
        sys.exit("protoc failed")
    sys.path.insert(0, STUBS)
    import grpc
    import frame_ingress_pb2 as pb
    import frame_ingress_pb2_grpc as rpc

    stub = rpc.FrameIngressStub(grpc.insecure_channel(args.grpc))
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        cmd = json.loads(line)
        request = pb.FrameRequest(ver=1, id=cmd.get("id", 0), session=cmd.get("session", 1), event=pb.TRACK_EVENT_REMOVED)
        record = cmd.get("record")
        if record is not None:
            request.record.code = record.get("code", 0)
            request.record.frame_id = record.get("frame_id", 0)
            request.record.camera_mask = record.get("camera_mask", 0)
            request.record.zone = record.get("zone", 0)
            request.record.count = record.get("count", 0)
            request.record.ts = record.get("ts", 0)
            gps = record.get("gps")
            if gps is not None:
                request.record.gps.lat = gps["lat"]
                request.record.gps.lon = gps["lon"]
                request.record.gps.valid = gps.get("valid", True)
        # Как мастер: после перезапуска шлюза запрос досылается, пока канал не поднимется
        for attempt in range(5):
            try:
                reply = stub.SendFrame(request, timeout=15, wait_for_ready=True)
                out = {"accepted": reply.accepted, "error": reply.error, "transport": reply.transport, "wire_size": reply.wire_size}
                break
            except grpc.RpcError as e:
                out = {"accepted": False, "error": f"rpc: {e.code().name} {e.details()}"}
                if e.code() != grpc.StatusCode.UNAVAILABLE:
                    break
                time.sleep(0.5)
        print(json.dumps(out), flush=True)


if __name__ == "__main__":
    main()
