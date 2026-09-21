"""Observed actions through Browser Harness; one CDP session, no per-step subprocess."""

import hashlib
import json
import sys
import time
from pathlib import Path

from browser_harness.admin import ensure_daemon
from browser_harness.helpers import cdp, close_tab, new_tab

# Atomically read visible content and controls, preserving actual DOM node identity.
READ_STATE = Path(__file__).with_name("snapshot.js").read_text()
MARKER = f"(() => {{ const state={READ_STATE}; return state?.marker ?? null; }})()"

class StalePage(ValueError):
    """A decision no longer refers to the observed page."""


class BrowserDisconnected(RuntimeError):
    """The CDP/daemon connection dropped during an operation. str() is user-facing."""


# CDP methods that only read state or (re)build the harness's own target/session:
# replaying one after a dropped connection cannot change page content. Everything
# else (Input.*, Emulation.*, Target.closeTarget, ...) can mutate the page and is
# never replayed.
IDEMPOTENT_METHODS = frozenset({
    "Runtime.evaluate",
    "Page.captureScreenshot",
    "Page.navigate",
    "Target.getTargets",
    "Target.createTarget",
    "Target.attachToTarget",
})

# The first attempt plus up to two reconnects, with a small bounded backoff.
RETRY_ATTEMPTS = 3
RETRY_BACKOFF_SECONDS = (0.25, 0.5)

# The harness defaults to a 5 s IPC deadline. A heavy SPA (Facebook Marketplace)
# can legitimately take longer to evaluate, and a timeout there used to be reported
# as a failed source.
CDP_RESPONSE_TIMEOUT_SECONDS = 25.0

# helpers._send relays the daemon's str(exception) as a RuntimeError. A dropped
# CDP WebSocket surfaces as websockets.ConnectionClosed -> "no close frame
# received or sent"; a missed daemon socket as an OSError. Match both.
CONNECTION_LOST_MARKERS = (
    "no close frame",
    "close frame",
    "connection closed",
    "connection reset",
    "connection refused",
    "connection aborted",
    "connection error",
    "broken pipe",
    "websocket",
    "not connected",
    "disconnected",
    "going away",
)


def connection_lost(exc):
    """True when `exc` looks like a dropped daemon/CDP connection, not a CDP error."""
    if isinstance(exc, OSError):  # incl. TimeoutError, ConnectionResetError, ...
        return True
    text = str(exc).lower()
    return any(marker in text for marker in CONNECTION_LOST_MARKERS)


# A CDP error, not a transport drop: the target/session Hearth was driving is gone
# (Chrome discards background tabs under memory pressure). Recoverable by reopening.
DETACHED_MARKERS = (
    "no target with given id",
    "session with given id not found",
    "no session with given id",
    "-32001",
)


def detached(exc):
    """True when the cause is a target/session that no longer exists."""
    if isinstance(exc, BrowserDisconnected) and not connection_lost(exc):
        return False
    text = str(exc).lower()
    return any(marker in text for marker in DETACHED_MARKERS)


def cdp_call(method, session_id=None, retry=True, **params):
    """Run one CDP call, surviving a dropped connection for read-only methods.

    When `retry` is allowed and `method` is idempotent, a dropped connection is
    transparent: ensure_daemon() is re-run and the call is retried with a small
    bounded backoff. A page-changing method is issued exactly once; if the
    connection drops around it the loss is raised as a clear BrowserDisconnected
    so it is never replayed.
    """
    attempts = RETRY_ATTEMPTS if retry and method in IDEMPOTENT_METHODS else 1
    params.setdefault("_response_timeout", CDP_RESPONSE_TIMEOUT_SECONDS)
    last = None
    for attempt in range(attempts):
        try:
            return cdp(method, session_id=session_id, **params)
        except Exception as exc:
            if not connection_lost(exc):
                raise
            last = exc
            if attempts == 1:
                raise BrowserDisconnected(
                    "The browser connection dropped during a page-changing action "
                    f"({method}); it was not retried, so the page may be in an unknown "
                    "state. Observe the page again before continuing."
                ) from exc
            if attempt + 1 == attempts:
                break
            try:
                ensure_daemon()
            except Exception as reconnect:  # surface it only if the retry also fails
                last = reconnect
            time.sleep(RETRY_BACKOFF_SECONDS[min(attempt, len(RETRY_BACKOFF_SECONDS) - 1)])
    raise BrowserDisconnected(
        f"The browser connection dropped during {method} and could not be restored "
        f"after {attempts} attempts: {last}"
    ) from last


class Browser:
    """Drives one owned tab through the harness daemon.

    The daemon tracks which tab is attached, so no CDP session id is held here: a
    discarded tab is reopened and re-attached instead of turning into a stale-session
    error on the next call.
    """

    def __init__(self, url):
        ensure_daemon()
        self.url = url
        self.target = None
        self.reopens = 0
        self.open(url)

    def open(self, url):
        self.target = new_tab(url)
        self.call("Emulation.setDeviceMetricsOverride", width=1120, height=780, deviceScaleFactor=1, mobile=False)
        # Keep rAF/menus rendering in an owned background tab, without activating the user's Chrome tab.
        self.call("Emulation.setFocusEmulationEnabled", enabled=True)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if self.evaluate("document.readyState") == "complete":
                break
            time.sleep(0.02)
        self.wait_for_content()

    def wait_for_content(self, timeout=8.0):
        """readyState 'complete' arrives before a heavy SPA has painted anything readable.

        Facebook Marketplace reaches 'complete' with an empty innerText, which reads as
        an empty page to the model. Wait (bounded) for actual text before observing.
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                readable = self.evaluate("(document.body && document.body.innerText || '').trim().length")
            except Exception:
                readable = 0
            if readable:
                return True
            time.sleep(0.1)
        return False

    def reopen(self):
        """Chrome discarded this tab; open a fresh one on the page we were reading."""
        self.reopens += 1
        if self.reopens > 2:
            raise BrowserDisconnected(
                "Chrome keeps discarding the tab Hearth is using. Close some tabs, then start the search again."
            )
        self.after_input = None
        self.open(self.url)
        return self

    def call(self, method, **params):
        return cdp_call(method, **params)

    def evaluate(self, expression):
        response = self.call("Runtime.evaluate", expression=expression, returnByValue=True)
        if response.get("exceptionDetails"):
            raise StalePage("Document changed during evaluation")
        return response.get("result", {}).get("value")

    def observe(self, screenshot=True):
        if getattr(self, "after_input", None):
            action, self.after_input = self.after_input, None
            # This is read-only and happens after execution was logged, even if navigation interrupts it.
            try:
                self.call(
                    "Runtime.evaluate",
                    expression="""(action => new Promise(resolve => {
                      const field=window.__jevFast?.nodes.get(action.node);
                      const autocomplete=action.kind==='fill' && field?.getAttribute('role')==='combobox';
                      let frames=0, stopped=false;
                      const finish=()=>{stopped=true;resolve()};
                      setTimeout(finish,autocomplete ? 200 : 50);
                      const ready=()=>{
                        if (stopped) return;
                        const ids=(field?.getAttribute('aria-controls')||field?.getAttribute('aria-owns')||'')
                          .split(/\\s+/).filter(Boolean);
                        const roots=ids.length ? ids.map(id=>document.getElementById(id)).filter(Boolean) : [document];
                        const options=roots.flatMap(root=>[...root.querySelectorAll('[role="option"]')]);
                        if (++frames>=2 && (!autocomplete || options.some(e=>{
                          const r=e.getBoundingClientRect();
                          return r.width && r.height && r.bottom>0 && r.top<innerHeight &&
                            e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
                        }))) finish();
                        else requestAnimationFrame(ready);
                      };
                      requestAnimationFrame(ready);
                    }))(""" + json.dumps(action) + ")",
                    awaitPromise=True,
                    returnByValue=True,
                )
            except RuntimeError:
                pass
        for attempt in range(10):
            try:
                observed = browser_operation({"operation": "observe", "screenshot": screenshot})
                observed["captured_at"] = round(time.time() * 1000)
                self.url = observed["url"]
                self.reopens = 0
                return observed
            except StalePage:
                if attempt == 9:
                    raise
                time.sleep(0.02)
            except Exception as exc:
                if not detached(exc):
                    raise
                self.reopen()
        raise StalePage("Page did not settle")

    def fresh(self, page, action=None):
        try:
            if action is not None and action["kind"] in {"click", "select"}:
                node = action["node"]
                if type(node) is not int:
                    return False
                current = self.evaluate(
                    "(() => { const c=window.__jevFast; "
                    f"return c ? [c.pageKey(),c.guard(c.nodes.get({node}))] : null; }})()"
                )
                return current == [page["page_key"], page["guards"].get(str(node))]
            return self.evaluate(MARKER) == page["marker"]
        except Exception as exc:
            if not detached(exc):
                raise
            # The tab is gone, so nothing can match: reopen and let the caller re-observe.
            self.reopen()
            return False

    def act(self, action, page, text=None):
        if not self.fresh(page, action):
            raise StalePage("Page changed since this decision. Observe again.")
        if action["kind"] == "wait":
            time.sleep(0.1)
        result = browser_operation({"operation": "act", "action": action, "text": text})
        self.after_input = action if action["kind"] != "wait" else None
        return result

    def close(self):
        if self.target:
            try:
                close_tab(self.target)
            finally:
                self.target = None


def fingerprint(state):
    content = {k: state[k] for k in ("url", "text", "actions", "scroll")}
    return hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()


def browser_operation(request):
    operation = request["operation"]

    # The daemon already tracks the attached tab, so no session id is held or passed here.
    def call(method, retry=True, **params):
        return cdp_call(method, retry=retry, **params)

    def evaluate(expression, retry=True):
        result = call("Runtime.evaluate", retry=retry, expression=expression, returnByValue=True)
        if result.get("exceptionDetails"):
            if operation == "act" and request["action"]["kind"] == "select":
                raise RuntimeError("Dropdown execution was interrupted; inspect before retrying.")
            raise StalePage("Document changed during evaluation")
        return result.get("result", {}).get("value")

    if operation == "act":
        action = request["action"]
        kind = action["kind"]
        if kind == "scroll":
            call("Input.dispatchMouseEvent", type="mouseWheel", x=550, y=650, deltaX=0, deltaY=action["delta"])
        elif kind != "wait":
            if type(action["node"]) is not int:
                raise ValueError("Invalid observed node")
            # Code-owned node IDs refer to actual observed elements, never model-generated selectors.
            target = evaluate("""(action => {
              const e=window.__jevFast?.nodes.get(action.node);
              if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
                  !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
              if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
              const r=e.getBoundingClientRect();
              if (!r.width || !r.height) return null;
              const points=[[.5,.5],[.25,.5],[.75,.5],[.5,.25],[.5,.75],[.2,.2],[.8,.2],[.2,.8],[.8,.8]]
                .map(([px,py])=>({x:r.x+r.width*px,y:r.y+r.height*py}))
                .filter(p=>p.x>=0&&p.y>=0&&p.x<innerWidth&&p.y<innerHeight);
              const point=points.find(p=>e.contains(document.elementFromPoint(p.x,p.y)));
              if (!point) return null;
              if (action.kind==='select') {
                if (e.tagName!=='SELECT' || ![...e.options].some(o=>o.value===action.value &&
                    !o.disabled && !o.closest('optgroup[disabled]'))) return null;
                e.value=action.value;
                e.dispatchEvent(new Event('input',{bubbles:true}));
                e.dispatchEvent(new Event('change',{bubbles:true}));
              }
              return point;
            })(""" + json.dumps(action) + ")", retry=kind != "select")
            if target is None:
                if kind == "select":
                    raise RuntimeError("Dropdown execution was not confirmed; inspect before retrying.")
                raise StalePage("Target changed or is covered. Observe again.")
            if kind != "select":
                x, y = target["x"], target["y"]
                for event in ("mousePressed", "mouseReleased"):
                    call("Input.dispatchMouseEvent", type=event, x=x, y=y, button="left", clickCount=1)
                if kind == "fill":
                    call(
                        "Input.dispatchKeyEvent",
                        type="keyDown",
                        key="a",
                        code="KeyA",
                        modifiers=4 if sys.platform == "darwin" else 2,
                        commands=["selectAll"],
                    )
                    call(
                        "Input.dispatchKeyEvent",
                        type="keyUp",
                        key="a",
                        code="KeyA",
                        modifiers=4 if sys.platform == "darwin" else 2,
                    )
                    call("Input.insertText", text=request["text"])
        return {"executed": action["id"]}

    info = evaluate(READ_STATE)
    if info is None:
        raise StalePage("Document is navigating")
    info["fingerprint"] = fingerprint(info)
    if request.get("screenshot", True):
        info["screenshot"] = call("Page.captureScreenshot", format="jpeg", quality=72)["data"]
    return info
