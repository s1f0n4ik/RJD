import argparse
import json
import threading
import time
from pathlib import Path

import gi

gi.require_version('Gst', '1.0')
gi.require_version('GstRtspServer', '1.0')
from gi.repository import GLib, Gst, GstRtspServer

ENCODE = 'x264enc tune=zerolatency speed-preset=ultrafast key-int-max=25 ! h264parse ! rtph264pay name=pay0 pt=96 config-interval=1'


class Looper:
    # Отдельный конвейер читает файл по кругу, кадры получают время в appsrc RTSP: при повторе оно не прыгает назад
    def __init__(self, uri: str):
        self.src = None
        self.lock = threading.Lock()
        self.pipe = Gst.parse_launch(f'uridecodebin uri={uri} ! videoconvert ! videoscale ! video/x-raw,format=I420 ! appsink name=out sync=true max-buffers=2 drop=true emit-signals=true')
        self.pipe.get_by_name('out').connect('new-sample', self.on_sample)
        bus = self.pipe.get_bus()
        bus.add_signal_watch()
        bus.connect('message::eos', lambda *_: self.pipe.seek_simple(Gst.Format.TIME, Gst.SeekFlags.FLUSH | Gst.SeekFlags.KEY_UNIT, 0))
        bus.connect('message::error', lambda _, m: print(json.dumps({'error': m.parse_error()[0].message}), flush=True))
        self.pipe.set_state(Gst.State.PLAYING)

    def on_sample(self, sink):
        sample = sink.emit('pull-sample')
        with self.lock:
            src = self.src
        if src is not None:
            src.set_caps(sample.get_caps())
            buffer = sample.get_buffer().copy()
            buffer.pts = buffer.dts = Gst.CLOCK_TIME_NONE
            src.emit('push-buffer', buffer)
        return Gst.FlowReturn.OK

    def attach(self, factory, media):
        src = media.get_element().get_by_name('src')
        with self.lock:
            self.src = src
        media.connect('unprepared', lambda *_: self.detach(src))

    def detach(self, src):
        with self.lock:
            if self.src is src:
                self.src = None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('video')
    parser.add_argument('--port', default='8554')
    parser.add_argument('--mount', default='/ISAPI/Streaming/Channels/101')
    # Повтор файла без конца: камера для долгой проверки нейросети
    parser.add_argument('--loop', action='store_true')
    args = parser.parse_args()
    Gst.init(None)
    server = GstRtspServer.RTSPServer()
    server.set_service(args.port)
    def client_connected(server, client):
        client.connect('play-request', lambda *args: print(json.dumps({'play_ms': round(time.time()*1000)}), flush=True))
    server.connect('client-connected', client_connected)
    factory = GstRtspServer.RTSPMediaFactory()
    uri = Path(args.video).resolve().as_uri()
    if args.loop:
        looper = Looper(uri)
        factory.set_launch(f'( appsrc name=src is-live=true do-timestamp=true format=time ! videoconvert ! {ENCODE} )')
        factory.connect('media-configure', looper.attach)
    else:
        factory.set_launch(f'( uridecodebin uri={uri} ! videoconvert ! videoscale ! video/x-raw,format=I420 ! {ENCODE} )')
    factory.set_shared(True)
    server.get_mount_points().add_factory(args.mount, factory)
    if server.attach(None)==0:
        raise RuntimeError('Cannot bind RTSP listener')
    print(json.dumps({'ready': True, 'port': args.port, 'mount': args.mount, 'loop': args.loop}), flush=True)
    GLib.MainLoop().run()


if __name__ == '__main__':
    main()
