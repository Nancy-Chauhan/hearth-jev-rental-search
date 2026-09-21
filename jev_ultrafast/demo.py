"""Loopback-only inspector for the Jev browser agent."""

import atexit
import json
import os
import re
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from .agent import Agent
from .browser import StalePage
from .questions import MAX_STEPS

STATIC_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
STATIC_MIME = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".json": "application/json",
}

ROOT = Path(__file__).parent
PORT = int(os.environ.get("TYPESAFE_DEMO_PORT", "8766"))
HOST = (os.environ.get("TYPESAFE_DEMO_HOST") or "127.0.0.1").strip() or "127.0.0.1"
WILDCARD = HOST in {"0.0.0.0", "::"}
ORIGIN = f"http://127.0.0.1:{PORT}"
TOKEN = secrets.token_urlsafe(32)
LOCK = threading.Lock()
AGENT = None


def host_allowed(header):
    """Only the configured interface answers. A wildcard bind accepts any host on its port."""
    if not header:
        return False
    if WILDCARD:
        return header.endswith(f":{PORT}")
    return header in {f"{HOST}:{PORT}", f"127.0.0.1:{PORT}", f"localhost:{PORT}", f"[::1]:{PORT}"}


def origin_allowed(origin, request_host):
    """Same-origin, or a non-browser client that sends no Origin. Cross-site pages are refused."""
    if origin is None:
        return True
    return origin in {f"http://{request_host}", f"https://{request_host}"}


def load_environment():
    path = Path.cwd() / ".env"
    if path.exists():
        for line in path.read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                key, value = line.split("=", 1)
                os.environ.setdefault(key, value)


DEFAULT_PRICE_PER_BTOK = 42.0


def reported_price(name, default=None):
    """Operator-configured token rate. Never guessed by the app."""
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    return value if value >= 0 else default


def response_state():
    state = AGENT.snapshot() if AGENT else {"page": None, "status": "idle", "history": [], "decision": None}
    return {
        **state,
        "text_model": os.environ.get("TEXT_MODEL", "deepseek-chat"),
        "max_steps": MAX_STEPS,
        "configuration": {
            "typesafe": bool(os.environ.get("TYPESAFE_API_KEY")),
            "text_model": bool(os.environ.get("TEXT_MODEL_API_KEY")),
        },
        "pricing": {
            "per_btok": reported_price("TYPESAFE_PRICE_PER_BTOK", DEFAULT_PRICE_PER_BTOK),
            "input_per_mtok": reported_price("TYPESAFE_PRICE_INPUT_PER_MTOK"),
            "output_per_mtok": reported_price("TYPESAFE_PRICE_OUTPUT_PER_MTOK"),
        },
    }


def close_browser():
    global AGENT
    if AGENT:
        AGENT.close()
        AGENT = None


def command(name, body):
    global AGENT
    if name == "reset":
        text_values = body.get("text_values") or {}
        if not isinstance(text_values, dict) or len(text_values) > 16:
            raise ValueError("Invalid supplied text values")
        for name, item in text_values.items():
            if (
                not isinstance(name, str)
                or not name.replace("_", "").isalnum()
                or not isinstance(item, dict)
                or not isinstance(item.get("value"), str)
                or not 0 < len(item["value"]) <= 2000
                or not isinstance(item.get("description"), str)
                or not 0 < len(item["description"]) <= 500
            ):
                raise ValueError("Invalid supplied text value")
        required_keys = ["TYPESAFE_API_KEY"] + ([] if text_values else ["TEXT_MODEL_API_KEY"])
        missing = [name for name in required_keys if not os.environ.get(name)]
        if missing:
            raise ValueError(f"Add {', '.join(missing)} to .env, then restart Hearth.")
        scenario = body.get("scenario", "craigslist")
        if scenario not in {"travel", "research", "flights", "marketplace", "craigslist", "redfin", "zillow"}:
            raise ValueError("Unknown demo scenario")
        goal = body.get("goal", "").strip()
        if not goal or len(goal) > 2000:
            raise ValueError("Enter 1–2,000 characters")
        close_browser()
        real_urls = {
            "flights": "https://www.google.com/travel/flights?hl=en",
            "marketplace": "https://www.facebook.com/marketplace/category/propertyrentals/",
            "craigslist": (
                "https://www.craigslist.org/search/city/san-francisco-ca"
                "?cat=apa&lat=37.7429&lon=-122.433&radius=4.8#search=2~gallery~6"
            ),
            "redfin": "https://www.redfin.com/city/17151/CA/San-Francisco/apartments-for-rent",
            "zillow": "https://www.zillow.com/san-francisco-ca/rentals/",
        }
        AGENT = Agent(
            real_urls.get(scenario, f"{ORIGIN}/fixture.html?scenario={scenario}"),
            goal,
            screenshots=True,
            record_dir=Path.cwd() / "artifacts" / "frames" if body.get("record") else None,
            text_values=text_values,
        )
        AGENT.state["scenario"] = scenario
    else:
        if AGENT is None:
            raise ValueError("Start a demo first")
        try:
            AGENT.command(name, body)
        except StalePage:
            if name != "act":
                raise
            AGENT.command("refresh")
    return response_state()


class Handler(BaseHTTPRequestHandler):
    def send(self, status, content, mime="application/json"):
        content = content if isinstance(content, bytes) else content.encode()
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self):
        if not host_allowed(self.headers.get("Host")):
            return self.send(403, "Forbidden", "text/plain")
        path = urlparse(self.path).path
        if path == "/api/state":
            with LOCK:
                return self.send(200, json.dumps(response_state()))
        if path == "/demo.mp4":
            video = ROOT.parent / "docs" / "demo.mp4"
            if video.exists():
                return self.send(200, video.read_bytes(), "video/mp4")
        # Text files that embed the per-run demo token.
        files = {
            "/": ("index.html", "text/html"),
            "/index.html": ("index.html", "text/html"),
            "/app.js": ("app.js", "text/javascript"),
            "/report.js": ("report.js", "text/javascript"),
            "/query.js": ("query.js", "text/javascript"),
            "/telemetry.js": ("telemetry.js", "text/javascript"),
            "/style.css": ("style.css", "text/css"),
            "/fixture.html": ("fixture.html", "text/html"),
        }
        if path in files:
            name, mime = files[path]
            content = (ROOT / "static" / name).read_text().replace("__TOKEN__", TOKEN)
            return self.send(200, content, mime + "; charset=utf-8")
        # Anything else in static/ is served verbatim, so adding a module cannot 404 here.
        name = path.lstrip("/")
        target = ROOT / "static" / name
        if not STATIC_NAME.fullmatch(name) or not target.is_file():
            return self.send(404, "Not found", "text/plain")
        self.send(200, target.read_bytes(), STATIC_MIME.get(target.suffix, "application/octet-stream"))

    def do_POST(self):
        host = self.headers.get("Host")
        if (
            not host_allowed(host)
            or self.headers.get("X-Demo-Token") != TOKEN
            or not origin_allowed(self.headers.get("Origin"), host)
        ):
            return self.send(403, json.dumps({"error": "Local demo requests only"}))
        if not LOCK.acquire(blocking=False):
            return self.send(409, json.dumps({"error": "A browser step is already running"}))
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length < 8192:
                raise ValueError("Invalid request size")
            body = json.loads(self.rfile.read(length))
            result = command(self.path.removeprefix("/api/"), body)
            self.send(200, json.dumps(result))
        except (ValueError, RuntimeError, TimeoutError) as error:
            self.send(400, json.dumps({"error": str(error)}))
        except Exception:
            self.send(500, json.dumps({"error": "Local demo failed; no automatic retry. Reset to recover."}))
        finally:
            LOCK.release()

    def log_message(self, *_args):
        pass


def main():
    load_environment()
    atexit.register(close_browser)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Jev Ultrafast: http://{HOST}:{PORT}", flush=True)
    if not WILDCARD and HOST in {"127.0.0.1", "localhost"}:
        print("Bound to loopback only. Set TYPESAFE_DEMO_HOST=0.0.0.0 to reach it from another device.", flush=True)
    else:
        print(
            "WARNING: bound beyond loopback. Anyone who can reach this port can drive the Chrome profile "
            "it controls, and the demo token is readable from GET /. Use a trusted network only.",
            flush=True,
        )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
