# Hearth: watch an AI agent search four rental marketplaces

Hearth is a small local web app that drives a **real Chrome browser** to search Craigslist, Facebook
Marketplace, Redfin and Zillow for a rental, and folds what it finds into one shortlist. You give it a
single request in plain language; it decides every click itself, and it shows you each decision as it
happens.

Nothing is simulated. The panel on the right is a live view of the tab the agent is driving, the actions
are real clicks and keystrokes, and the spend counter is real model usage.

<img src="jev_ultrafast/static/backdrop.jpg" alt="Illustrated San Francisco street of painted rowhouses stepping down toward the bay" width="100%" />

*San Francisco, illustrated. The same artwork that sits behind the Hearth app, and the city its default
search is set to.*

**Hearth will never message a seller, save a listing, or start a transaction.** It reads pages and reports
what it found.

## ▶ Watch it work

<!--
 VIDEO SLOT: paste the demo recording here.

 Drag hearth.mp4 into this spot in the GitHub README editor. GitHub uploads it and inserts a
 user-attachments URL, which renders as an inline player. Leave that URL alone on its own line, e.g.:

     https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000000

 When the video is in place, delete the placeholder line below it.
-->

**Demo video: space reserved.**

A full search at its original speed: one request, four marketplaces, one shortlist.

## Before you start

| You need | Why | Notes |
| --- | --- | --- |
| **[uv](https://docs.astral.sh/uv/)** | Installs Python and every dependency | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| **Python 3.12+** | The agent | `uv` will fetch it for you |
| **Google Chrome** | The agent drives Chrome, and voice search uses Chrome's speech API | Brave and embedded Chromium do **not** expose the Web Speech API |
| **A TypeSafe API key** | Jev chooses each operation and target | <https://typesafe.ai>. Paid, but a search costs a fraction of a cent (see [Configuration](#configuration)) |

You do **not** need a text-model key for the rental workflow: the sidebar supplies the exact field values,
and Jev picks among those inside the same request.

## Setup

### 1. Get the code and install

```bash
git clone https://github.com/Nancy-Chauhan/hearth-jev-rental-search.git
cd hearth-jev-rental-search
uv sync
```

### 2. Add your key

```bash
cp .env.example .env
```

Open `.env` and set `TYPESAFE_API_KEY`. Everything else in that file is optional and is documented in
[Configuration](#configuration).

### 3. Start a Chrome that the agent may drive

Use a **dedicated profile**, not your everyday one: the agent types and clicks in this browser.

```bash
# macOS
profile=$(mktemp -d /tmp/hearth-chrome.XXXXXX)
open -na 'Google Chrome' --args \
  --remote-debugging-port=9222 \
  --user-data-dir="$profile" \
  --no-first-run --no-default-browser-check about:blank

# Linux
google-chrome --remote-debugging-port=9222 \
  --user-data-dir=/tmp/hearth-chrome \
  --no-first-run --no-default-browser-check about:blank
```

### 4. Run Hearth

```bash
BU_CDP_URL=http://127.0.0.1:9222 uv run jev
```

### 5. Open it

Open **<http://127.0.0.1:8766>** in your normal Chrome. The header should say **Jev ready**. If it says
*Setup needed*, the key in `.env` was not picked up. Restart the server after editing it.

> **Which Chrome is which?** Two are involved. The one from step 3 is the browser the agent drives. The one
> you open in step 5 only displays Hearth and the frames the agent sends back.

## Using Hearth

### 1. Describe the search, or set the filters by hand

Two ways in, and they write to the same place:

- **The request bar** takes a whole request, typed or spoken, and parses it into the sidebar filters before
  the search starts:
  `studio in Oakland under $2,500, near BART` → **Where** `Oakland`, **budget** `$2,000-$2,500`,
  **home type** `Studio`, and `near BART` kept as the free-text preference.
  It understands upper bounds, lower bounds, ranges (`between 1500 and 2500`, `2000-3000`), `$`, `k`, and
  spoken numbers (`twenty five hundred`). A line under the bar tells you what it applied.
- **The sidebar** sets the same four things directly: **Where**, **Monthly budget**, **Home type**
  (Apartment / Studio / House) and **Listed within**. Pick which marketplaces to search in **Search
  everywhere**.

Whatever you do not override stays as-is. The request bar only ever fills fields from what you actually
said. It will not invent a budget, and `1200 sqft` or `near BART` are never mistaken for a price or a city.

**Voice:** press **Speak**, describe the home, then stop talking. It keeps listening through pauses and
starts the search after about 1.8 seconds of silence, or immediately if you press **Speak** again. Chrome
may ask for microphone permission the first time.

### 2. Start the search

Press **Start searching**. Hearth opens one tab per source in the Chrome from setup step 3 and works
through them in order.

### 3. Watch the run

- The **browser panel** shows the live tab, with the address bar and a frame timer that tells you how fresh
  the picture is (`LAST FRAME · 3s` means the frame is three seconds old).
- The **activity rail** lists what happened, newest first: one card per action with its cost, its duration,
  the model that decided it, and whether the page actually changed.
- The **counters** across the top are cumulative for the whole search: pages visited, browser actions,
  elapsed wall time, and estimated AI spend.
- The **source tabs** show each marketplace's state: `Finished`, `Partial`, or a wall such as `Bot check`.
- **Stop** is always available and stops after the request in flight.

### 4. Read the results

When sources finish, Hearth shows:

- **A first-match card** as soon as one candidate passes every check.
- **Your shortlist:** the best few candidates, each with photo, rent, facts, and a numbered badge.
- **The match report:** up to 18 cards from every source, interleaved so no single marketplace takes over
  the list, each one labelled with *why* it is there and which checks it passed.

Every card is labelled honestly. A tick means the listing's own text proves that check; a question mark
means the source did not state it, so `? City unconfirmed` is not a pass, and a candidate is not a verified
home. Missing facts read `not provided` rather than pretending to be zero. **Confirm availability on the
original listing**; Hearth only reports what it observed.

### 5. Developer mode

The **Developer** toggle (in the browser panel header) is off by default and reveals the machinery this
project is really about: manual **Choose** / **Execute** stepping, action confidence, target overlays, and
the structured inspector showing the numbered element table and the operation/target probabilities Jev
returned.

## Sources, and the walls they put up

Marketplaces defend themselves against automation, and results differ by site. Hearth **detects** a wall,
labels it, keeps any cards it already has, and moves on. It will not try to solve a CAPTCHA or a
verification challenge for you.

Measured on one machine, same day:

| Source | Wall | What we saw |
| --- | --- | --- |
| **Craigslist** | none | 24 cards on the first page |
| **Facebook Marketplace** | none | works signed out; a signed-in profile collects more |
| **Redfin** | AWS WAF (`Are You a Robot?`) | cleared by an export containing `aws-waf-token` |
| **Zillow** | PerimeterX (`Press & Hold`) | needs `_px3`; got in once, then blocked again |

Walls are scored per **IP and session**, not per site: a headed Chrome loaded Zillow while an identical
headless one was refused, and the result flipped between runs. If a source keeps blocking:

- Run the demo with the sources that work. The quickest three-source path is Craigslist + Facebook + Redfin.
- For Redfin, load a cookie export that includes `aws-waf-token` (below).
- For Zillow, `_px3` expires in roughly 30 minutes, and heavy automated traffic makes the block worse. A
  different network is usually the only thing that reliably resets it.
- If a wall does appear and you clear it by hand in the agent's Chrome window, press **Continue with this
  source** to pick it back up.

### Loading a signed-in session (optional)

Exports are read from a path, stay outside this repository, and print counts, never values:

```bash
uv run python scripts/load_cookies.py ~/Downloads/cookies-redfin.json
```

Treat these files as live credentials; a Facebook `c_user`/`xs` pair is full account access. Rotate
anything you have shared.

## Configuration

Everything lives in `.env` (see `.env.example`). Only the first one is required.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | none | **Required.** Key for the model that chooses each action |
| `TYPESAFE_MODEL` | `jev-latest` | Which Jev revision to ask |
| `TEXT_MODEL_API_KEY` | none | Only needed for goals with no supplied field values |
| `TEXT_MODEL_BASE_URL` | OpenRouter | Any OpenAI-compatible endpoint |
| `TEXT_MODEL` | `inception/mercury-2.5` | Model that writes field text |
| `TEXT_MODEL_REASONING` | `none` | Reasoning effort for the text helper |
| `TYPESAFE_PRICE_PER_BTOK` | `42` | Flat rate, **per billion tokens**, for the spend estimate |
| `TYPESAFE_PRICE_INPUT_PER_MTOK` / `_OUTPUT_PER_MTOK` | none | Split rates; take precedence if both set |
| `BU_CDP_URL` | none | Chrome to drive, e.g. `http://127.0.0.1:9222` |
| `TYPESAFE_DEMO_HOST` | `127.0.0.1` | Set `0.0.0.0` to accept connections from your network |
| `TYPESAFE_DEMO_PORT` | `8766` | Port Hearth listens on |

**About AI spend.** TypeSafe reports tokens, not dollars, so the counter converts the token total at your
configured rate and always labels it an estimate: `$0.0024 · 57K tokens at $42 per 1B tokens · estimate`.
If a provider ever reports an explicit USD cost, that is shown verbatim instead. Unknown cost shows as a
dash, never `$0.00`.

### Reach Hearth from another device

The server binds to loopback by default. To open it from a phone or another machine on the same network:

```bash
TYPESAFE_DEMO_HOST=0.0.0.0 uv run jev      # then visit http://<this-machine-ip>:8766
```

**Be clear about what that exposes.** This port drives the Chrome profile the agent is using, including any
signed-in sessions, and the per-run token is readable by anyone who can load `/`. What still holds: a
mutation must carry that token *and* be same-origin, so a random web page you visit cannot drive the agent
(verified: foreign `Origin` → 403, wrong token → 403, path traversal → 404). What does not: anyone on the
network can read the token from `/` and then drive the agent. Use it on a network you trust. The agent's own
Chrome debugging port stays loopback-only.

## How Jev works

**A browser agent with a dynamic, indexed action space.** Give it one goal;
[TypeSafe's Jev](https://docs.typesafe.ai/introduction) picks an operation and an element. A small LLM
writes text only when the operation is `TYPE_TEXT`.

```
                      one TypeSafe request
                     ┌───────────────────────────┐
page → element table → operation                 │
                     │ click_target              │
                     │ type_text_target          │
                     │ select_target, if present │
                     └─────────────┬─────────────┘
                         use the matching target
                                   │
                    CLICK [7] ─────┤──→ browser
                TYPE_TEXT [3] ─────┘
                          ↓
                   small LLM → text → browser
```

Every observation produces a fresh element table:

```text
[1] button    Change ticket type · Round trip
[2] combobox  Where from?        · San Francisco
[3] combobox  Where to?          · empty
[4] textbox   Departure          · empty
```

The operations are `CLICK`, `TYPE_TEXT`, `SELECT`, `SCROLL_UP`, `SCROLL_DOWN`, `WAIT`, `DONE` and `BLOCKED`,
and only supported combinations are offered. Target questions are speculative: if the operation is `CLICK`,
only `click_target` can execute. Two decisions, **one network round trip**.

Model output never becomes selectors, coordinates, shell commands or executable JavaScript. Every executed
target is resolved from an observed DOM node and re-checked for freshness and occlusion immediately before
input. There are no per-site action scripts in the policy: the same generic policy drives all four
marketplaces, and Craigslist, Zillow and Facebook look nothing alike.

## Project layout

| Path | Job |
| --- | --- |
| `jev_ultrafast/agent.py` | The decision/execution loop and text-helper handoff |
| `jev_ultrafast/model.py` | Operation/target heads and supplied-text choices |
| `jev_ultrafast/questions.py` | The browsing policy: the only place behaviour is described |
| `jev_ultrafast/browser.py` | Chrome connection, geometry, execution |
| `jev_ultrafast/snapshot.js` | Atomic DOM snapshot, indexed controls, listing-card and detail extraction |
| `jev_ultrafast/demo.py` | Local server and source start URLs |
| `jev_ultrafast/static/app.js` | The UI: source sequence, tabs, voice, report |
| `jev_ultrafast/static/report.js` | Filtering, dedup, ranking, source balancing (DOM-free) |
| `jev_ultrafast/static/query.js` | Turns a spoken/typed request into sidebar filters (DOM-free) |
| `jev_ultrafast/static/telemetry.js` | Cost, duration and action wording (DOM-free) |
| `tests/` | Offline contracts: policy, guard freshness, filter/parse/telemetry logic |

`PROGRESS.md` carries the engineering handoff: verified runs, the source-by-source findings behind the
table above, and the UX evaluation this UI was rebuilt against.

## Development

```bash
uv run ruff check .
uv run pytest
node --check jev_ultrafast/static/app.js
node --check jev_ultrafast/static/report.js
node --check jev_ultrafast/static/query.js
node --check jev_ultrafast/static/telemetry.js
node --check jev_ultrafast/snapshot.js
node --test tests/report.test.js
node --test tests/query.test.js
node --test tests/telemetry.test.js
uv build
```

Tests are offline and call no paid APIs. The Node suites cover the pure modules: report filtering, the
request parser, and telemetry formatting. `uv run python scripts/check_guards.py` exercises real controls in
a local browser without model calls. `scripts/smoke.py` and `examples/` make paid calls by design.

## Security and limits

- Everything runs on your machine. Keys stay server-side and `.env` is gitignored.
- Hearth only reads pages and clicks controls it observed. It never enters credentials, creates accounts,
  messages sellers, saves listings or pays for anything.
- It refuses to solve verification challenges. A wall is reported, not defeated.
- Candidates are not verified homes: Hearth reports what a listing's own page states, and availability,
  accuracy and recency still need the original listing.
- Partial runs happen: a source may stop early on a wall, a rate limit or a step budget, and Hearth says so
  instead of presenting it as a finished search.
- The extractor reads what is rendered, so a source with lazy loading yields more cards the further it
  scrolls. Shadow roots, frames, canvas, uploads and nested scrolling are outside this MVP.

---

Hearth is built on **[Jev Ultrafast](https://github.com/browser-use/jev-ultrafast)** by
[Browser Use](https://github.com/browser-use/browser-use), with decisions from
[TypeSafe](https://docs.typesafe.ai/patterns/fan-out). MIT licensed. See [LICENSE](LICENSE).
