import asyncio

from tokengrill.dbus.clients import ClientTracker

WAIT = 5.0


class Probe:
    def __init__(self) -> None:
        self.shell: list[bool] = []
        self.idle = asyncio.Event()

    def tracker(self, idle_seconds: float = 0.05) -> ClientTracker:
        return ClientTracker(self.shell.append, self.idle.set, idle_seconds)


async def test_shell_client_starts_and_stops_scheduling() -> None:
    probe = Probe()
    tracker = probe.tracker(60)
    tracker.add(":1.1", "shell")
    assert tracker.has_shell
    tracker.add(":1.2", "shell")
    tracker.remove(":1.1")
    assert tracker.has_shell
    tracker.remove(":1.2")
    assert not tracker.has_shell
    assert probe.shell == [True, False]
    tracker.close()


async def test_idle_after_last_client() -> None:
    probe = Probe()
    tracker = probe.tracker()
    tracker.add(":1.1", "prefs")
    tracker.add(":1.2", "shell")
    tracker.remove(":1.2")
    await asyncio.sleep(0.15)
    assert not probe.idle.is_set()
    tracker.remove(":1.1")
    await asyncio.wait_for(probe.idle.wait(), WAIT)


async def test_returning_client_cancels_idle() -> None:
    probe = Probe()
    tracker = probe.tracker()
    tracker.add(":1.1", "shell")
    tracker.remove(":1.1")
    tracker.add(":1.2", "shell")
    await asyncio.sleep(0.2)
    assert not probe.idle.is_set()
    tracker.close()


async def test_cli_client_does_not_keep_service_alive() -> None:
    probe = Probe()
    tracker = probe.tracker()
    tracker.add(":1.1", "cli")
    assert not tracker.has_shell
    await asyncio.wait_for(probe.idle.wait(), WAIT)
    assert probe.shell == []


async def test_unknown_sender_removal_is_ignored() -> None:
    probe = Probe()
    tracker = probe.tracker(60)
    tracker.add(":1.1", "shell")
    tracker.remove(":1.9")
    assert tracker.has_shell
    tracker.close()


async def test_hello_again_replaces_the_kind() -> None:
    probe = Probe()
    tracker = probe.tracker(60)
    tracker.add(":1.1", "shell")
    tracker.add(":1.1", "prefs")
    assert not tracker.has_shell
    assert probe.shell == [True, False]
    tracker.close()


async def test_call_in_flight_keeps_service_alive() -> None:
    probe = Probe()
    tracker = probe.tracker()
    tracker.add(":1.1", "cli")
    tracker.call_started()
    await asyncio.sleep(0.2)
    assert not probe.idle.is_set()
    tracker.call_finished()
    await asyncio.wait_for(probe.idle.wait(), WAIT)
