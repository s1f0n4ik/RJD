import argparse
import json
import time
from pathlib import Path

import gi

gi.require_version('Gst', '1.0')
gi.require_version('GstRtspServer', '1.0')
from gi.repository import GLib, Gst, GstRtspServer


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('video')
    parser.add_argument('--port', default='8554')
    parser.add_argument('--mount', default='/ISAPI/Streaming/Channels/101')
    args = parser.parse_args()
    Gst.init(None)
    server = GstRtspServer.RTSPServer()
    server.set_service(args.port)
    def client_connected(server, client):
        client.connect('play-request', lambda *args: print(json.dumps({'play_ms': round(time.time()*1000)}), flush=True))
    server.connect('client-connected', client_connected)
    factory = GstRtspServer.RTSPMediaFactory()
    factory.set_launch('( uridecodebin uri='+Path(args.video).resolve().as_uri()+' ! videoconvert ! videoscale ! video/x-raw,format=I420 ! x264enc tune=zerolatency speed-preset=ultrafast key-int-max=25 ! h264parse ! rtph264pay name=pay0 pt=96 config-interval=1 )')
    factory.set_shared(True)
    server.get_mount_points().add_factory(args.mount, factory)
    if server.attach(None)==0:
        raise RuntimeError('Cannot bind RTSP listener')
    print(json.dumps({'ready': True, 'port': args.port, 'mount': args.mount}), flush=True)
    GLib.MainLoop().run()


if __name__ == '__main__':
    main()
