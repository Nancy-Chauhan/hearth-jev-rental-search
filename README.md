<img src="jev_ultrafast/static/backdrop.jpg" alt="Illustrated San Francisco street of painted rowhouses stepping down toward the bay" width="100%" />

# Hearth: an AI agent that searches four rental marketplaces

Hearth drives a real Chrome browser to search Craigslist, Facebook Marketplace, Redfin and Zillow from one
plain-language request, and returns a single shortlist of matching rentals. You watch every click it makes
as it goes.

It never messages a seller, saves a listing or starts a transaction. It only reads pages and reports what it
found.

https://github.com/user-attachments/assets/ba58c178-1367-4e83-b77f-0f0476652ff1

## What you need

- **[uv](https://docs.astral.sh/uv/)** to run the app and install everything
- **Google Chrome**. Hearth drives it, and voice search needs it
- **A [TypeSafe](https://typesafe.ai) API key**. A search costs a fraction of a cent

## Setup

**1. Clone and install**

```bash
git clone https://github.com/Nancy-Chauhan/hearth-jev-rental-search.git
cd hearth-jev-rental-search
uv sync
```

**2. Add your key**

```bash
cp .env.example .env
```

Open `.env` and set `TYPESAFE_API_KEY`. Nothing else is required.

**3. Start a Chrome that Hearth may drive**

Use a separate profile, not your everyday one.

```bash
# macOS
profile=$(mktemp -d /tmp/hearth-chrome.XXXXXX)
open -na 'Google Chrome' --args --remote-debugging-port=9222 \
  --user-data-dir="$profile" --no-first-run --no-default-browser-check about:blank

# Linux
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/hearth-chrome \
  --no-first-run --no-default-browser-check about:blank
```

**4. Run Hearth**

```bash
BU_CDP_URL=http://127.0.0.1:9222 uv run jev
```

**5. Open it**

Open <http://127.0.0.1:8766> in your normal Chrome. The header should say **Jev ready**.

Two Chromes are involved. The one from step 3 is the browser Hearth controls, and the one from step 5 only
displays the app. If the header does not say **Jev ready**, the key in `.env` was not picked up, so restart
the server.

## Using Hearth

1. Type or speak your search in the bar at the top, for example `studio in Oakland under $2,500, near BART`.
   Hearth fills in the filters for you. You can also set them by hand on the left: where, monthly budget,
   home type, how recently listed, and which marketplaces to search.
2. Press **Start searching**. Hearth opens one tab per marketplace and works through them in order.
3. Watch the run. The live browser view is on the right, and every action Hearth takes appears in the
   activity rail with its cost and duration. Press **Stop** at any time.
4. Read the results. Hearth shows a first match, a shortlist, and a report of up to 18 listings from every
   source, each with a photo, rent, facts and a direct link.

Listings are labelled honestly. A tick means the listing's own text proved that detail, and a question mark
means the marketplace did not state it. Always confirm availability on the original listing.

## Marketplaces

Hearth searches Craigslist, Facebook Marketplace, Redfin and Zillow. Sometimes a marketplace shows a bot
check, a sign-in wall or a rate limit. Hearth reports it on the source tab, keeps the listings it already
collected, and moves on to the next source. It will not solve a CAPTCHA for you. If you clear a check by
hand in the agent's Chrome window, press **Continue with this source** to resume.

### Signing in to a marketplace (optional)

Craigslist works straight away. Facebook Marketplace, Redfin and Zillow often work better with a signed-in
session, and some of them show a bot check without one.

Sign in as usual in your own browser, export those cookies, and load them into the Chrome Hearth drives:

```bash
uv run python scripts/load_cookies.py ~/Downloads/cookies.json
```

The cookies are written into that Chrome's profile, so they survive restarts. They are live credentials:
keep the export outside this repository (`.gitignore` already blocks `cookies*.json`), and rotate anything
you have shared.

## Good to know

- Everything runs on your machine. Your API key stays in `.env`, which is never committed.
- Hearth only reads pages and clicks controls it can see. It does not enter credentials or create accounts.
- Results reflect what a listing page says, so availability and details can change.
- A source may stop early. Hearth says so instead of pretending the search finished.
- Other settings are optional and documented in `.env.example`.

---

Built on **[Jev Ultrafast](https://github.com/browser-use/jev-ultrafast)** by
[Browser Use](https://github.com/browser-use/browser-use), with decisions from
[TypeSafe](https://docs.typesafe.ai/patterns/fan-out). MIT licensed. See [LICENSE](LICENSE).
