import asyncio

from app.devices.pyrometers import DiscreteDriver, KelvinDriver, PyrometerBoardDriver
from app.line import LineManager


def make(driver, **config):
    values, events = [], []
    source = {
        "kind": "test",
        "port": "COM6",
        "baudrate": 9600,
        "slave_id": 12,
        **config,
    }
    return driver("device", source, values.append, events.append, LineManager()), values, events


def by_channel(values):
    return {value.channel_id: value.value for value in values}


def test_board_maps_pairs_and_calculates_overheat():
    driver, values, _ = make(
        PyrometerBoardDriver,
        pair_targets=["air", "left_rail", "ballast", "right_rail"],
        max_delta=20,
    )
    driver.accept_registers([10, 0, 35, 50, 8, 25, 29, 99])
    result = by_channel(values)
    assert result["air"] == 10
    assert result["left_rail"] == 35.5
    assert result["left_rail_delta_air"] == 25.5
    assert result["left_rail_overheat"] is True
    assert result["right_rail_overheat"] is False


def test_board_falls_back_to_single_register_reads():
    driver, values, _ = make(PyrometerBoardDriver)
    expected = [10, 0, 35, 50, 8, 25, 29, 99]
    calls = []

    class Client:
        def read_registers(self, start, count, holding=False):
            calls.append((start, count, holding))
            if count != 1:
                raise TimeoutError("batch reads are not supported")
            return [expected[start - 999]]

    async def exchange(operation):
        return operation(Client())

    driver.exchange = exchange
    asyncio.run(driver.poll())
    assert calls[0] == (999, 8, False)
    assert calls[1:] == [(address, 1, False) for address in range(999, 1007)]
    assert driver._working_read == (999, True)
    assert by_channel(values)["left_rail"] == 35.5


def test_kelvin_decodes_signed_temperatures_and_flags():
    driver, values, _ = make(
        KelvinDriver,
        slave_id=1,
        object_target="left_rail",
        ambient_target="air",
    )
    driver.accept_registers([1 << 4, 250, 0xFFF6, 205])
    result = by_channel(values)
    assert result["object_filtered"] == 25
    assert result["object_instant"] == -1
    assert result["sensor_ambient"] == 20.5
    assert result["left_rail"] == -1
    assert result["air"] == 20.5


def test_discrete_debounces_trip_change():
    driver, values, events = make(DiscreteDriver, slave_id=11, debounce_samples=3)
    driver.accept_registers([3, 0, 0, 0, 0])
    driver.accept_registers([3, 0, 0, 0, 0])
    assert "trip" not in by_channel(values)
    driver.accept_registers([3, 0, 0, 0, 0])
    assert by_channel(values)["trip"] is True
    assert events[-1].kind == "trip_changed"
    assert events[-1].payload == {"active": True, "state": 3}
