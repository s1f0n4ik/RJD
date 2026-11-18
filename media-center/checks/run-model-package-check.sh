#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
PYTHON=${PYTHON:-python3}
"$PYTHON" - "$dir" <<'EOF'
import sys, zipfile
d = sys.argv[1]
weights = b"RKNN" + bytes(range(256)) * 300
open(f"{d}/weights.bin", "wb").write(weights)

def pack(name, method, entries, comment=b""):
    with zipfile.ZipFile(f"{d}/{name}", "w", method) as z:
        for entry, data in entries:
            z.writestr(entry, data)
        z.comment = comment

manifest = ("manifest.json", '{"name": "Объекты пути"}'.encode("utf-8"))
pack("good.rjdm", zipfile.ZIP_STORED, [manifest, ("weights.rknn", weights)])
pack("comment.rjdm", zipfile.ZIP_STORED, [manifest, ("weights.rknn", weights)], comment=b"x" * 5000)
pack("deflated.rjdm", zipfile.ZIP_DEFLATED, [manifest, ("weights.rknn", weights)])
pack("only-manifest.rjdm", zipfile.ZIP_STORED, [manifest])
EOF
g++ -std=c++20 -O0 -Wall -Iinclude checks/model-package-check.cpp -o "$dir/model-package-check"
"$dir/model-package-check" "$dir"
