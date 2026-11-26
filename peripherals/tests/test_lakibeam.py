import struct

from app.devices.lakibeam import BLOCK_MARKER, LakiBeamParser


def datagram(azimuth: int) -> bytes:
    block = struct.pack("<HH" + "HB" * 32, BLOCK_MARKER, azimuth, *([1000, 20] * 32))
    return block * 12 + b"\x00" * 6


def test_parser_completes_revolution():
    parser = LakiBeamParser()
    assert parser.feed(datagram(34000)) == []
    scans = parser.feed(datagram(0))
    assert len(scans) == 1
    assert len(scans[0]["points"]) == 384
    assert scans[0]["points"][0]["distance_mm"] == 1000
