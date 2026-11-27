from app.devices.sick import SickColaAParser


def telegram(body: str) -> bytes:
    return b"\x02" + body.encode() + b"\x03"


def test_parser_reads_fragmented_cola_a_scan():
    parser = SickColaAParser()
    data = telegram(
        "sSN LMDscandata 1 1 DIST1 3F800000 00000000 FFF92230 D05 3 3E8 0 7D0"
    )
    assert parser.feed(data[:17]) == []
    scans = parser.feed(data[17:])
    assert len(scans) == 1
    assert scans[0]["source"] == "sick_cola_a"
    assert scans[0]["points"] == [
        {"angle_deg": -45.0, "distance_mm": 1000, "intensity": 0},
        {"angle_deg": -44.3334, "distance_mm": 2000, "intensity": 0},
    ]


def test_parser_reads_ident_and_rssi():
    parser = SickColaAParser()
    parser.feed(telegram("sRA DeviceIdent 6 TiM561 E V2.61-12.10.18"))
    assert parser.device_ident == "TiM561 V2.61-12.10.18"
    scans = parser.feed(telegram(
        "sSN LMDscandata DIST1 3F800000 00000000 0 2710 2 64 C8 "
        "RSSI1 3F800000 00000000 0 2710 2 A 14"
    ))
    assert [point["intensity"] for point in scans[0]["points"]] == [10, 20]
