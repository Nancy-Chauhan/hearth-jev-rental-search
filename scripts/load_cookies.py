"""Load cookie exports into the Chrome that BU_CDP_URL points at.

Usage:
    uv run python scripts/load_cookies.py path/to/cookies.json [more.json ...]

The export is the JSON shape produced by common cookie-editor extensions: a list of
{name, value, domain, path, secure, httpOnly, expirationDate, sameSite, session}.
Nothing is written into this repository, and only counts are printed -- never values.
Live session cookies belong in the Chrome profile, not in a commit.
"""

import json
import sys
import time
from pathlib import Path

from browser_harness.admin import ensure_daemon
from browser_harness.helpers import cdp, close_tab, new_tab

# CDP accepts None/Lax/Strict; extension exports use no_restriction for None.
SAME_SITE = {"no_restriction": "None", "lax": "Lax", "strict": "Strict"}


def to_cdp(cookie):
    if not cookie.get("name") or "domain" not in cookie:
        raise ValueError("Cookie entries need at least name and domain")
    out = {
        "name": cookie["name"],
        "value": cookie.get("value", ""),
        "domain": cookie["domain"],
        "path": cookie.get("path") or "/",
        "secure": bool(cookie.get("secure")),
        "httpOnly": bool(cookie.get("httpOnly")),
    }
    if cookie.get("expirationDate") and not cookie.get("session"):
        out["expires"] = float(cookie["expirationDate"])
    same_site = SAME_SITE.get(str(cookie.get("sameSite") or "").lower())
    if same_site:
        out["sameSite"] = same_site
    return out


def load(path):
    cookies = json.loads(Path(path).read_text())
    if not isinstance(cookies, list):
        raise ValueError(f"{path}: expected a JSON list of cookies")
    hosts = {}
    for cookie in cookies:
        hosts.setdefault(cookie["domain"].lstrip("."), []).append(to_cdp(cookie))
    for host, batch in sorted(hosts.items()):
        target = new_tab(f"https://{host}/")
        try:
            time.sleep(1.5)
            session = cdp("Target.attachToTarget", targetId=target, flatten=True)["sessionId"]
            cdp("Network.enable", session_id=session)
            cdp("Network.setCookies", session_id=session, cookies=batch)
            cdp("Target.detachFromTarget", sessionId=session)
        finally:
            close_tab(target)
        print(f"{host}: {len(batch)} cookies loaded from {Path(path).name}")


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    ensure_daemon()
    for path in sys.argv[1:]:
        load(path)


if __name__ == "__main__":
    main()
