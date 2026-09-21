"""Offline reliability contracts for the CDP layer.

The daemon lives behind browser_harness.helpers.cdp, so these tests mock the
cdp/ipc boundary: no browser, no network, no paid APIs. They cover the
"no close frame received or sent" failure seen on long multi-source runs.
"""

import pytest

from jev_ultrafast import browser as browser_module
from jev_ultrafast.browser import BrowserDisconnected, browser_operation

# The exact message a dropped CDP WebSocket surfaces through helpers.cdp.
DROP = "no close frame received or sent"

OBSERVED = {"url": "https://example.test/", "text": "hello", "actions": [], "scroll": {"y": 0}}
POINT = {"x": 12.0, "y": 34.0}


class FakeCDP:
    """Stands in for browser_harness.helpers.cdp at the CDP/IPC boundary."""

    def __init__(self, *, drops=None, always_drop=(), evaluate=OBSERVED):
        self.calls = []
        self.drops = {method: list(failures) for method, failures in (drops or {}).items()}
        self.always_drop = set(always_drop)
        self.evaluate = evaluate
        self.events = []

    def __call__(self, method, session_id=None, **params):
        self.calls.append(method)
        self.events.append(("cdp", method))
        if method in self.always_drop:
            raise RuntimeError(DROP)
        queued = self.drops.get(method)
        if queued:
            raise queued.pop(0)
        if method == "Runtime.evaluate":
            return {"result": {"value": dict(self.evaluate)}}
        if method == "Page.captureScreenshot":
            return {"data": "c2NyZWVuc2hvdA=="}
        return {}

    def count(self, method):
        return self.calls.count(method)


@pytest.fixture
def wire(monkeypatch):
    """Patch the cdp + ensure_daemon boundary and record the exact call order."""
    events = []

    def ensure_daemon(*_args, **_kwargs):
        events.append(("ensure_daemon",))

    monkeypatch.setattr(browser_module, "ensure_daemon", ensure_daemon)
    monkeypatch.setattr(browser_module, "RETRY_BACKOFF_SECONDS", (0, 0))

    def connect(fake):
        fake.events = events
        monkeypatch.setattr(browser_module, "cdp", fake)
        return fake

    return connect, events


def test_read_only_call_retries_after_a_drop(wire):
    connect, events = wire
    fake = connect(FakeCDP(drops={"Runtime.evaluate": [RuntimeError(DROP)]}))
    observed = browser_operation({"operation": "observe", "session": "s", "screenshot": False})
    assert observed["url"] == OBSERVED["url"]
    assert "fingerprint" in observed
    assert fake.count("Runtime.evaluate") == 2
    # ensure_daemon() runs between the failed attempt and the retry.
    assert events == [("cdp", "Runtime.evaluate"), ("ensure_daemon",), ("cdp", "Runtime.evaluate")]


def test_screenshot_read_retries_after_a_drop(wire):
    connect, events = wire
    fake = connect(FakeCDP(drops={"Page.captureScreenshot": [RuntimeError(DROP)]}))
    observed = browser_operation({"operation": "observe", "session": "s", "screenshot": True})
    assert observed["screenshot"] == "c2NyZWVuc2hvdA=="
    assert fake.count("Page.captureScreenshot") == 2
    assert ("ensure_daemon",) in events


def test_oserror_from_the_ipc_boundary_is_retried(wire):
    connect, _events = wire
    fake = connect(FakeCDP(drops={"Runtime.evaluate": [ConnectionResetError("Connection reset by peer")]}))
    observed = browser_operation({"operation": "observe", "session": "s", "screenshot": False})
    assert observed["url"] == OBSERVED["url"]
    assert fake.count("Runtime.evaluate") == 2


@pytest.mark.parametrize(
    ("kind", "action", "mutating_call"),
    [
        ("click", {"id": "e1", "kind": "click", "label": "Go", "node": 7}, "Input.dispatchMouseEvent"),
        ("fill", {"id": "e1", "kind": "fill", "label": "Query", "node": 7}, "Input.insertText"),
    ],
)
def test_mutation_is_never_replayed_after_a_drop(wire, kind, action, mutating_call):
    connect, events = wire
    fake = connect(FakeCDP(drops={mutating_call: [RuntimeError(DROP)]}, evaluate=POINT))
    with pytest.raises(BrowserDisconnected) as err:
        browser_operation({"operation": "act", "session": "s", "action": action, "text": "book"})
    # The mutation is attempted exactly once and never triggers a reconnect.
    assert fake.count(mutating_call) == 1
    assert ("ensure_daemon",) not in events
    message = str(err.value)
    assert "not retried" in message
    assert mutating_call in message


def test_select_mutation_is_never_replayed(wire):
    connect, events = wire
    # A native select changes its value inside Runtime.evaluate, so that read is
    # issued once too and must not be replayed.
    fake = connect(FakeCDP(always_drop=("Runtime.evaluate",)))
    action = {"id": "e1", "kind": "select", "node": 7, "value": "Design"}
    with pytest.raises(BrowserDisconnected):
        browser_operation({"operation": "act", "session": "s", "action": action, "text": None})
    assert fake.count("Runtime.evaluate") == 1
    assert ("ensure_daemon",) not in events


def test_persistent_drop_raises_a_clear_error(wire):
    connect, events = wire
    fake = connect(FakeCDP(always_drop=("Runtime.evaluate",)))
    with pytest.raises(BrowserDisconnected) as err:
        browser_operation({"operation": "observe", "session": "s", "screenshot": False})
    assert fake.count("Runtime.evaluate") == browser_module.RETRY_ATTEMPTS
    assert len([event for event in events if event == ("ensure_daemon",)]) == browser_module.RETRY_ATTEMPTS - 1
    message = str(err.value).lower()
    assert "connection dropped" in message
    assert DROP in message


def test_genuine_cdp_error_is_not_retried_or_masked(wire):
    connect, events = wire
    fake = connect(FakeCDP(drops={"Runtime.evaluate": [RuntimeError("Invalid parameters")]}))
    with pytest.raises(RuntimeError) as err:
        browser_operation({"operation": "observe", "session": "s", "screenshot": False})
    assert not isinstance(err.value, BrowserDisconnected)
    assert "Invalid parameters" in str(err.value)
    assert fake.count("Runtime.evaluate") == 1
    assert ("ensure_daemon",) not in events
