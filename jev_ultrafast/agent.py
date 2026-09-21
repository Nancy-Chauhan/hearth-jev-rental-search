"""The complete agent loop. Typed choices, observable state, bounded execution."""

import base64
import time
import uuid
from pathlib import Path

from .browser import Browser, StalePage
from .model import NoTextValue, action_space, choose, field_context, field_text
from .questions import MAX_STEPS

MAX_STALE_RETRIES = 3


class Agent:
    def __init__(self, url, goals, *, record_dir=None, screenshots=False, text_values=None):
        task = goals.strip() if isinstance(goals, str) else "\n".join(goals).strip()
        if not task:
            raise ValueError("Supply a task")
        plan = [task]
        self.pending_text = None
        self.text_values = text_values or {}
        self.browser = Browser(url)
        self.record_dir = Path(record_dir) if record_dir else None
        self.screenshots = screenshots or bool(record_dir)
        try:
            page = self.browser.observe(screenshot=self.screenshots)
        except Exception:
            self.browser.close()
            raise
        self.state = dict(
            run_id=uuid.uuid4().hex,
            browser=self.browser,
            goal="\n".join(plan),
            page=page,
            decision=None,
            history=[],
            status="ready",
            plan=plan,
            plan_index=0,
            decisions=[],
            text_calls=[],
            elapsed_ms=0,
            started_at=None,
            record=bool(self.record_dir),
        )
        if self.record_dir:
            self.record_dir.mkdir(parents=True, exist_ok=True)
            (self.record_dir / "000000.jpg").write_bytes(base64.b64decode(page["screenshot"]))

    def snapshot(self):
        return {
            **{k: v for k, v in self.state.items() if k != "browser"},
            "elements": action_space(self.state["page"]["actions"])[0],
        }

    def stop(self, reason):
        self.state.update(status="blocked", decision=None, stop_reason=reason)
        self.pending_text = None
        if self.state["started_at"] is not None:
            self.state["elapsed_ms"] = round((time.perf_counter() - self.state["started_at"]) * 1000)
        return self.snapshot()

    def command(self, name, body=None):
        body = body or {}
        state = self.state
        if name == "visit":
            # Bounded, model-free enrichment: open one observed listing read-only and re-read
            # the page, so its detail facts can join the collected listing.
            if not state["browser"]:
                raise ValueError("Start a demo first")
            url = str(body.get("url", ""))
            if not url.startswith(("http://", "https://")):
                raise ValueError("A visit needs an absolute http(s) URL")
            state["browser"].call("Page.navigate", url=url)
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if state["browser"].evaluate("document.readyState") == "complete":
                    break
                time.sleep(0.05)
            # A heavy SPA reports 'complete' before it paints anything readable.
            state["browser"].wait_for_content()
            state["page"] = state["browser"].observe(screenshot=self.screenshots)
            state["status"] = "ready"
            state["decision"] = None
            if state["started_at"] is not None:
                state["elapsed_ms"] = round((time.perf_counter() - state["started_at"]) * 1000)
        elif name == "tick":
            if state["status"] in {"done", "blocked"}:
                return self.snapshot()
            try:
                self.command("predict", {})
                if state["status"] in {"done", "blocked"}:
                    return self.snapshot()
                self.command("act", {"fingerprint": state["page"]["fingerprint"]})
                state["stale_retries"] = 0
                return self.snapshot()
            except StalePage:
                state["decision"] = None
                state["stale_retries"] = state.get("stale_retries", 0) + 1
                if state["stale_retries"] >= MAX_STALE_RETRIES:
                    return self.stop("Page kept changing during recovery. Let it settle, then refresh to continue.")
                state["status"] = "ready"
                try:
                    state["page"] = state["browser"].observe(screenshot=self.screenshots)
                except StalePage:
                    # The next tick makes a fresh decision; never replay the old action.
                    pass
                state["elapsed_ms"] = round((time.perf_counter() - state["started_at"]) * 1000)
                return self.snapshot()
        elif name == "predict":
            if not state["browser"]:
                raise ValueError("Start a demo first")
            if state["started_at"] is None:
                state["started_at"] = time.perf_counter()
            if not state["browser"].fresh(state["page"]):
                state["page"] = state["browser"].observe(screenshot=self.screenshots)
            state["decision"] = None
            if state["status"] in {"done", "blocked"}:
                raise ValueError("This run has stopped. Start a fresh demo.")
            if len(state["decisions"]) >= MAX_STEPS * 2:
                return self.stop("Reached the demo's model-call budget. Start a new run with a narrower goal.")
            try:
                state["decision"] = choose(
                    state["page"], state["goal"], state["history"], getattr(self, "text_values", None)
                )
            except NoTextValue as exc:
                # Jev picked a text field nothing in the request belongs in. That is a
                # legitimate outcome, so the source stops as partial, not as a failure.
                return self.stop(str(exc))
            state["decision"]["call_id"] = uuid.uuid4().hex
            state["decisions"].append(
                {
                    **state["decision"],
                    "fingerprint": state["page"]["fingerprint"],
                    "elapsed_ms": round((time.perf_counter() - state["started_at"]) * 1000),
                }
            )
            state["status"] = "predicted"
        elif name == "act":
            decision, page = state["decision"], state["page"]
            if not decision or body.get("fingerprint") != page["fingerprint"]:
                raise ValueError("Observe and choose before acting")
            # Consume once, before any mutation or model call. A retry cannot double-click.
            state["decision"] = None
            selected = decision["choice"]
            if selected in {"DONE", "BLOCKED"}:
                if not state["browser"].fresh(page):
                    state["status"] = "ready"
                    raise StalePage("Page changed since the decision. Choose again.")
                state["status"] = "done" if selected == "DONE" else "blocked"
                if selected == "BLOCKED":
                    state["stop_reason"] = (
                        "The model found no supported next action. Inspect the page before continuing."
                    )
                state["plan_index"] = int(selected == "DONE")
                state["elapsed_ms"] = round((time.perf_counter() - state["started_at"]) * 1000)
                return self.snapshot()
            action = next(a for a in page["actions"] if a["id"] == selected)
            action_started = time.perf_counter()
            if len(state["history"]) >= MAX_STEPS:
                return self.stop(
                    f"Stopped at the {MAX_STEPS}-action demo budget. Start a new run with a narrower goal."
                )
            text, helper = None, None
            text_source = None
            helper_reused = False
            if action["kind"] == "fill":
                if not state["browser"].fresh(page):
                    raise StalePage("Page changed before text generation. Choose again.")
                if decision.get("text") is not None:
                    text = decision["text"]
                    helper = {"model": f"{decision['model']} · supplied value", "latency_ms": 0}
                    text_source = "supplied"
                else:
                    context = field_context(state["goal"], action, page, state["history"])
                    if self.pending_text and self.pending_text[0] == context:
                        _, text, helper = self.pending_text
                        helper_reused = True
                    else:
                        text, helper = field_text(context)
                        helper = {**helper, "call_id": uuid.uuid4().hex}
                        self.pending_text = (context, text, helper)
                        # Count a billable request once, even if stale input later reuses its result.
                        state["text_calls"].append({**helper, "field": action["label"], "value": text})
                    text_source = "reused" if helper_reused else "generated"
            # Browser.act checks freshness immediately before input, including after text generation.
            browser_started = time.perf_counter()
            state["browser"].act(action, page, text=text)
            browser_ms = round((time.perf_counter() - browser_started) * 1000)
            self.pending_text = None
            state["elapsed_ms"] = round((time.perf_counter() - state["started_at"]) * 1000)
            # Record execution before observing. A stale post-action observation must not erase the action.
            state["history"].append(
                {
                    "step": len(state["history"]) + 1,
                    "action": action["label"],
                    "kind": action["kind"],
                    "choice": selected,
                    "probability": decision["probabilities"][selected],
                    "confidence": decision["confidence"],
                    "latency_ms": decision["latency_ms"],
                    "model": decision.get("model"),
                    "call_id": decision.get("call_id"),
                    "browser_ms": browser_ms,
                    "observation_ms": None,
                    "action_ms": None,
                    "total_ms": None,
                    "at": round(time.time() * 1000),
                    "text": text,
                    "text_source": text_source,
                    "text_usage": helper.get("usage", {}) if helper and text_source == "generated" else {},
                    "text_helper": helper["model"] if helper else None,
                    "text_latency_ms": helper["latency_ms"] if helper and not helper_reused else 0,
                    "operation": decision["operation"],
                    "target": decision["target"],
                    "page_changed": None,
                    "url": page["url"],
                    "usage": decision["usage"],
                    "executed_ms": round((time.perf_counter() - state["started_at"]) * 1000),
                    "elapsed_ms": state["elapsed_ms"],
                }
            )
            observation_started = time.perf_counter()
            state["page"] = state["browser"].observe(screenshot=self.screenshots)
            observation_ms = round((time.perf_counter() - observation_started) * 1000)
            action_ms = round((time.perf_counter() - action_started) * 1000)
            state["elapsed_ms"] = round((time.perf_counter() - state["started_at"]) * 1000)
            state["history"][-1].update(
                page_changed=state["page"]["fingerprint"] != page["fingerprint"],
                url=state["page"]["url"],
                elapsed_ms=state["elapsed_ms"],
                observation_ms=observation_ms,
                action_ms=action_ms,
                total_ms=decision["latency_ms"] + action_ms,
            )
            if state["record"]:
                (self.record_dir / f"{state['elapsed_ms']:06d}.jpg").write_bytes(
                    base64.b64decode(state["page"]["screenshot"])
                )
            repeated = state["history"][-3:]
            oscillating = (
                len(repeated) == 3
                and repeated[0]["kind"] == "click"
                and len({(h["action"], h["url"]) for h in repeated}) == 1
            )
            state["status"] = (
                "blocked"
                if oscillating
                or (len(repeated) == 3 and all(h["page_changed"] is False and h["kind"] != "wait" for h in repeated))
                else "ready"
            )
            if state["status"] == "blocked":
                return self.stop("Repeated actions made no useful progress. Inspect the page before continuing.")
        elif name == "refresh":
            state["decision"] = None
            state["stale_retries"] = 0
            state.pop("stop_reason", None)
            state["status"] = "ready"
            state["page"] = state["browser"].observe(screenshot=self.screenshots)
            if state["started_at"] is not None:
                state["elapsed_ms"] = round((time.perf_counter() - state["started_at"]) * 1000)
        else:
            raise ValueError("Unknown command")
        return self.snapshot()

    def run(self):
        while self.state["status"] not in {"done", "blocked"}:
            yield self.command("tick")

    def close(self):
        self.browser.close()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()
