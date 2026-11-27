import asyncio

import pytest
from app.lifecycle import Lifecycle
from app.line import LineManager
from app.registry import Registry


def test_profile_transition_configures_active_devices():
    async def exercise():
        registry = Registry()
        lifecycle = Lifecycle(registry)
        stopped = await lifecycle.stop({
            "transition_id": "t1",
            "previous_transition_id": "",
            "modules": ["peripherals"],
        })
        assert stopped["state"] == "stopped"
        await lifecycle.apply({
            "transition_id": "t1",
            "revision": "r1",
            "active": "kgf",
            "devices": {
                "board": {
                    "kind": "descriptor",
                    "name": "Board",
                    "channels": [{"id": "t", "name": "Temperature", "unit": "C"}],
                }
            },
        })
        started = await lifecycle.start({"transition_id": "t1", "revision": "r1"})
        assert started["state"] == "running"
        assert registry.describe()[0].id == "board"
        assert registry.describe()[0].state.value == "running"

    asyncio.run(exercise())


def test_non_kgf_profile_keeps_registry_empty():
    async def exercise():
        registry = Registry()
        lifecycle = Lifecycle(registry)
        await lifecycle.stop({"transition_id": "t2", "previous_transition_id": "", "modules": []})
        await lifecycle.apply({
            "transition_id": "t2", "revision": "r2", "active": "iskra", "devices": {"ignored": {"kind": "descriptor"}},
        })
        await lifecycle.start({"transition_id": "t2", "revision": "r2"})
        assert registry.describe() == []

    asyncio.run(exercise())


def test_same_port_has_one_line_owner():
    manager = LineManager()
    first = manager.line("COM6", 9600)
    second = manager.line("COM6", 9600)
    assert first is second
    with pytest.raises(ValueError, match="incompatible"):
        manager.line("COM6", 19200)


def test_running_package_is_restored_after_process_restart(tmp_path):
    async def exercise():
        state_file = tmp_path / "peripherals-state.json"
        first_registry = Registry()
        first = Lifecycle(first_registry, str(state_file))
        await first.stop({
            "transition_id": "persistent-transition",
            "previous_transition_id": "",
            "modules": ["peripherals"],
        })
        await first.apply({
            "transition_id": "persistent-transition",
            "revision": "persistent-revision",
            "active": "kgf",
            "devices": {
                "board": {
                    "kind": "descriptor",
                    "name": "Persisted board",
                    "channels": [{"id": "temperature", "name": "Temperature"}],
                },
            },
        })
        await first.start({"transition_id": "persistent-transition", "revision": "persistent-revision"})

        restored_registry = Registry()
        restored = Lifecycle(restored_registry, str(state_file))
        assert await restored.restore() is True
        assert restored.status()["restored"] is True
        assert restored.status()["revision"] == "persistent-revision"
        assert restored_registry.describe()[0].state.value == "running"
        assert restored_registry.describe()[0].name == "Persisted board"
        await first_registry.stop()
        await restored_registry.stop()

    asyncio.run(exercise())
