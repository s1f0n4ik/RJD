from __future__ import annotations

import argparse
import logging
from pathlib import Path

from app.common import Config, read_text
from app.master import Master
from app.minion import Minion
from app.web import serve

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)


def main() -> None:
    parser = argparse.ArgumentParser(description="VARAN system update service")
    parser.add_argument("mode", choices=("master", "minion"), help="master: rollout over all boards (127.0.0.1:8005); minion: this board (0.0.0.0:8004)")
    parser.add_argument("--state-dir", default="/var/lib/varan-updater", help="state, delivered files and logs")
    parser.add_argument("--port", type=int, help="override the listening port")
    args = parser.parse_args()

    # VERSION кладётся рядом с app/ при сборке пакета
    version = read_text(Path(__file__).resolve().parent.parent / "VERSION").strip() or "dev"
    cfg = Config(state_dir=Path(args.state_dir), version=version)
    cfg.state_dir.mkdir(parents=True, exist_ok=True)
    if args.mode == "master":
        service, host, port = Master(cfg), "127.0.0.1", args.port or cfg.master_port
    else:
        service, host, port = Minion(cfg), "0.0.0.0", args.port or cfg.minion_port
    server = serve(service.routes(), host, port)
    logger.info(f"update-{args.mode} {version} listening on {host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
