# Hearth project handoff

Updated: 2026-09-20 (America/Los_Angeles)

## Repository

- Local checkout: `/Users/chauhan/projects/jev-marketplace-search`
- Private GitHub repository: `git@github.com:Nancy-Chauhan/hearth-jev-rental-search.git`
- Web URL: <https://github.com/Nancy-Chauhan/hearth-jev-rental-search>
- Branch: `main`
- Latest published commit: `90fe1a2 Build autonomous multi-source Hearth rental search`
- Original project is preserved as the `upstream` remote: <https://github.com/browser-use/jev-ultrafast>

The original checkout was shallow. The first push failed with a missing Git object, not a Git hook.
The history was repaired with `git fetch --unshallow upstream`, after which the new private repository
accepted the branch. No active local Git hooks or hook frameworks were found; `.git/hooks` contains only
inactive `.sample` files.

## Product implemented

Hearth is a local rental-search interface powered by TypeSafe Jev. It currently provides:

- A polished responsive UI with filters on the left and a live browser view on the right.
- Location, monthly budget, home type, and listing-recency filters.
- An optional natural-language preference field.
- Voice input through Chrome's native `SpeechRecognition` API.
- All sources selected by default: Craigslist, Facebook Marketplace, Redfin, and Zillow.
- A visible source-tab strip with queued, working, checked, and completed states.
- Autonomous sequential searching across all selected sources.
- A persistent `SEARCHING ALL SOURCES` state during source transitions; site-level limitations are shown
  as `Source checked`, not as a global pause.
- A Stop button for explicit user cancellation.
- A generated match report containing direct listing links, available photos, price, beds, baths, square
  footage, source, and card text/description.
- Report-side enforcement of the requested price range and exclusion of houses/private rooms when the
  requested type is a flat.
- Up to 18 high-detail cards shown, ordered by metadata completeness and price, with the total match count.
- Exact sidebar text values selected by Jev in the same TypeSafe request. The rental workflow does not
  require `TEXT_MODEL_API_KEY`.
- The top search bar accepts a whole request, typed or spoken, and fills the sidebar filters before the
  search starts: budget (upper/lower bounds, ranges, `$`/`k`/spoken numbers), home type, and a capitalized
  location after “in”/“near”. Leftover text stays as the preference. A hint reports what was applied.
- Voice search keeps one recognition session open across pauses (`continuous`), submits only after ~1.8 s
  of silence or when “Speak” is tapped again, and reopens the session if Chrome ends it on its own. A
  brief hesitation mid-sentence no longer submits a partial request.
- An illustrated landing backdrop (`static/backdrop.jpg`, from `output/imagegen/06-...png`) with a cream
  wash, plus `favicon.svg`, `apple-touch-icon.png`, and description/OG/Twitter meta in `index.html`.
- Repeated-click oscillation protection and stale-page recovery.
- A clear terminal `Search complete` state with obsolete action controls removed.

Hearth never messages sellers, saves listings, or starts a transaction.

## Source behavior observed in live runs

### Craigslist

- Starts from the user-provided San Francisco location centered at latitude `37.7429`, longitude
  `-122.433`, radius `4.8` miles.
- Uses apartment category `cat=apa`.
- Verified final query included `min_price=2000`, `max_price=4000`, and `postedToday=1`.
- `postedToday=1` is a narrower safe subset of “within the last four weeks.”
- A verified run loaded 42 matching results.
- The extractor now recognizes Craigslist's newer `/view/d/<slug>/<token>` links and prefers the
  dedicated `.priceinfo` value, so cards are retained with the real rent instead of a title amount such
  as "$1,000 OFF". Verified with a live read-only probe: 24 cards retained with correct prices.

### Facebook Marketplace

- The supplied session cookies successfully authenticated a temporary Chrome profile.
- The cookies are intentionally not stored anywhere in the repository.
- Jev applied price and newest-first controls in live testing.
- Facebook can still end in `Source checked` when controls become non-responsive or requested filters are
  not exposed. The overall multi-source run continues autonomously.

### Redfin

- Redfin is included and receives its own source tab.
- Direct requests have intermittently returned rate-limit responses. Live browser runs may therefore end
  as `Source checked` while retaining visible cards for the combined report.

### Zillow

- Starts at `https://www.zillow.com/san-francisco-ca/rentals/`.
- Live runs successfully applied the `$2,000–$4,000` range in Zillow's `searchQueryState` URL.
- Zillow produced structured listing candidates with links, prices, and available facts.

## Verification completed

- `uv run ruff check .` passes.
- `uv run pytest` passes: 34 tests.
- `node --check jev_ultrafast/static/app.js` passes.
- `node --check jev_ultrafast/static/report.js` passes.
- `node --check jev_ultrafast/static/query.js` passes.
- `node --check jev_ultrafast/snapshot.js` passes.
- `node --test tests/report.test.js` passes: 12 report-filtering tests.
- `node --test tests/query.test.js` passes: 10 request-parser tests.
- `git diff --check` passes.
- `uv build` succeeds.
- A live capture of the reset payload confirms a spoken-style request now fills the sidebar: the text
  “studio in Oakland under $2,500 per month, near BART” produced location `Oakland`,
  `$2,000–$2,500`, home type `studio`, and the preference `near BART`.
- Desktop (1440×920) and narrow (400×900) screenshots were reviewed with the illustrated backdrop; the
  page logged no JavaScript errors and `/backdrop.jpg`, `/favicon.svg`, and `/apple-touch-icon.png` all
  return 200 with the correct content types.
- A scripted fake `SpeechRecognition` verified the voice flow with no microphone: results arriving every
  0.6 s kept `listening: true` with nothing submitted, and the request submitted only after the 1.8 s
  silence window — or immediately when “Speak” was tapped again. Both runs filled the sidebar
  (`Oakland · Studio · $2,000–$2,500`, then `Berkeley · Flat · $2,000–$3,000`).
- Note for the next agent: `Page.addScriptToEvaluateOnNewDocument` silently does nothing unless
  `Page.enable` is called first. Earlier “no console errors” readings taken without it were unverified; a
  corrected collector reported `errors: []` across a real Craigslist run.
- A real single-source Craigslist run through the Hearth UI reached `SEARCH COMPLETE` with no JavaScript
  errors, rendering `Showing 18 of 24` with every price inside $2,000–$4,000.
- A fresh full four-source UI run reached `SEARCH COMPLETE` in the same session. The report showed
  `Showing 18 of 60` with badges `flat · $2,000–$4,000/mo · San Francisco, CA · last four weeks ·
  Craigslist · 24 · Facebook Marketplace · 3 · Redfin · 24 · Zillow · 9`. All 18 rendered prices were
  inside $2,000–$4,000, all four source tabs stayed enabled/clickable, and the page logged no JavaScript
  errors.
- Source balancing interleaves sources in the first 18 cards (Redfin, Craigslist, Facebook, Zillow, …), so
  no single site crowds out the others. Missing facts render as `not provided` instead of zero.
- Independent DOM verification confirmed every rendered price was between `$2,000` and `$4,000`, every
  card had an HTTPS link, and images rendered where the source exposed a loaded image URL.

## Concurrent redesign and repair (same day)

A second, UX-review-driven redesign landed in `app.js`, `index.html`, and a new `static/telemetry.js`
while this handoff was being written. Two problems were found and fixed:

- **The app could not start.** `app.js` imports `./telemetry.js`, but `demo.py` served only an explicit
  file list, so `/telemetry.js` returned 404 and the module never evaluated — the page stayed on
  “Checking Jev…” forever. Fixed by adding the route and, more importantly, by serving any other file in
  `static/` through a filename-validated fallback so a new module can never 404 again.
- **The redesign had no styles.** `index.html` introduced `search-intro`, `live-metrics`, `live-layout`,
  `activity-rail`, `run-summary`, `search-chips`, `first-match`, `finale`, `shortlist-grid` and the
  listing-check markup, but none of them existed in `style.css`, so the layout collapsed into unstyled
  text. Added the missing component styles in the existing cream/sage language, plus a wrapping
  action dock, constrained shortlist/report grids, event-kind dot colours, and desktop/narrow rules.
  The duplicate panel headline was removed so the hero is the single H1.

## Reliability, policy, and UI pass

Three parallel workstreams on disjoint files (one writer per file, to avoid the earlier collision):

- **CDP reliability** (`jev_ultrafast/browser.py`): a dropped daemon connection (`no close frame received
  or sent`) no longer aborts a run. `cdp_call()` retries only idempotent CDP methods (Runtime.evaluate,
  Page.captureScreenshot, Page.navigate, Target.getTargets/createTarget/attachToTarget), re-running
  `ensure_daemon()` before each retry. A mutation is never replayed — the select path's
  `Runtime.evaluate` is issued with `retry=False`, and a drop around a click/fill raises
  `BrowserDisconnected` (a `RuntimeError` subclass) with a human sentence. Tests: `tests/test_reliability.py`.
- **Browsing policy** (`jev_ultrafast/questions.py`): the agent used to spend its whole budget on a
  map/radius control and then choose BLOCKED with 0 candidates. The policy now forbids re-adjusting a
  map/area/radius control once the location is set, says that adjusting the map is not progress, requires
  the results region to be inspected before BLOCKED, and bars BLOCKED while matching result cards are
  visible. No site-specific terms or field values were added. Tests: `tests/test_policy.py`.
- **Frontend polish** (`static/style.css`, `static/app.js`, `static/index.html`): the primary **CTA moved
  above the fold** (measured `#start` top 947px → 716px at 1280×800, bottom 766px), the hero **collapses
  when `body.has-run`** (112px → 39px), the **Developer toggle persists** in localStorage, and the type
  scale now has **no user-facing text below 9px**. The activity rail is now discrete **event cards** with
  a cost badge, a duration badge, an action sentence and a meta line; the in-flight action is the top card
  with a green border, and the list is capped at the latest 15. Internal failures are translated
  (`humanizeError`) so a dropped connection reads as "Lost the connection to Chrome…" rather than
  `no close frame received or sent`. The completion banner distinguishes a clean finish (green) from
  partial coverage (amber) and no longer claims "complete" when nothing passed the checks. Each search
  writes a shareable URL (`?location=…&min=…&max=…&type=…&days=…&sources=…&q=…`) that rebuilds the request
  on load. Tests: `tests/telemetry.test.js`.

Verified live at 1280×800: CTA visible without scrolling, hero 112→39px when running, rail hidden before a
run and 264px wide after, a real Craigslist run reached **Search complete** with `1 match passed every
check · 20 to review · 1 source checked`, 5 event cards, and `errors: []`. Offline: ruff clean, 56 pytest,
28 node tests, `uv build`.

Search identity and a clean home page:

- A bare `/` (no query string) is a clean slate. `initialize()` now clears the saved session and the request
  box when the URL has no parameters, so the stale completion banner and the previous query no longer
  reappear on the home page. Previously the run was restored from `sessionStorage` on every load.
- Every search gets a UUID. `startSearch` mints `run.id`, `syncUrl` writes `?s=<uuid>` alongside the
  filters, and `rememberSearch()` keeps the last 20 entries in `localStorage["hearth-searches"]`.
- Restoring results requires the URL to name that search (`?s=<uuid>` matching the stored run). A shared
  link rebuilds the request from its parameters; it does not resurrect another session's results.
- **AI spend is never a bare dash.** TypeSafe reports `{input_tokens, output_tokens}`, not USD (the old code
  only looked for `cost_usd`, so the tile always read "—"). The counter converts the real token total at a
  **flat default of $42 per billion tokens** (`DEFAULT_PRICE_PER_BTOK` in `demo.py`) and labels it as an
  estimate: `$0.0024 · 57K tokens at $42 per 1B tokens · estimate`. Override with
  `TYPESAFE_PRICE_PER_BTOK`, or set `TYPESAFE_PRICE_INPUT_PER_MTOK` / `_OUTPUT_PER_MTOK` for split rates,
  which take precedence. A provider-reported `cost_usd` is still shown verbatim. `Number(null)` is `0`, so an
  unset rate is treated as absent, never as free — there is a test for exactly that. Verified live:
  57K tokens → `$0.0024`; split rates 3/15 → `$0.2305`.
- Verified: home is clean (empty request, banner/metrics/rail hidden, defaults restored) → search assigns
  `?s=31b70b68-…` and records it in localStorage → reloading that URL restores the run → returning to `/`
  clears again → reopening the `?s=` link pre-fills the form with no stale banner.

## Report qualification and layout fixes

- **"0 MATCHES" was a real bug, not a display choice.** A listing counts as qualified only when all four
  checks pass (`price`, `location`, `home`, `recency`). The `home` check accepted only the literal words
  `apartment|flat|condo|studio|house|townhome|townhouse`, so ordinary Craigslist card text ("Luxury
  1BD/1BA", "1BR Home", "1 Bedroom 1 Bathroom Home", "Penthouse unit") scored `unknown` — and with an
  all-pass requirement the match count was structurally pinned at 0. Diagnosis on a live run showed
  `home` unknown on nearly every card.
- Fixed with `homeCheck(requestedType, text)` in `report.js`: `fail` only on a contradiction, `pass` when
  the card shows a self-contained dwelling ("1BD", "2BR", "1 Bedroom", "Home", "unit", "studio", "apartment"),
  `unknown` only with no signal. `mismatchesHomeType` now delegates to it, so there is one definition.
  Measured on a real run: 48 scanned → 21 kept → **5 qualified**, `home` passing on 15/21 (was ~0).
  The only remaining unknown is `location`: 16 cards show a neighbourhood, not "City, ST", and those stay
  honestly labelled `? City unconfirmed` rather than being promoted to a match.
- **A legacy `#history { max-height: 64px }` rule** survived from the pre-redesign stylesheet and fought the
  activity rail's own sizing (the same 64px scroll area the design review complained about). Removed.
- The activity rail has a bounded height (`min(74vh, 680px)`) and shows the recent events without
  scrolling: measured 5 of 5 fully visible with a 530px stream at 1280×800. (An earlier `align-items:
  stretch` made it match the frame exactly, but that also let an unbounded list stretch the whole page —
  see the Filtering fix below.)
- The illustration runs across the whole app again at `opacity: .34` behind a light veil, with panels at
  ~.84–.88 so text keeps contrast.
- **The Filtering tab was rendering 7195px tall** instead of scrolling: a grid item's `min-height: auto`
  resolves to its content height while `overflow` is `visible`, so 43 rows dragged the rail (and the page)
  down and the entries sat far below the fold. The rail now has a definite `height: min(74vh, 680px)` with
  `overflow: hidden`, so the stream scrolls in place — measured 410px tall with `scrollHeight` 4316.
- The amber completion banner was replaced by a compact **"See the results ↓"** button in the filter-chip
  row, alongside `Finished · N matches · M sources checked`. The **MATCHES tile was removed** and the
  metrics striped to four compact tiles (pages / actions / time / spend, 74px tall, was ~110px), so the
  browser frame moves up (frame top now 397px at 1280×800).

## Source transition sync and result exploration

- **The tab label used to update before the page did.** `startSearch` set `activeSource = backendSource =
  source` *before* awaiting the `reset` that actually opens the new site, so the header, address bar and
  tab highlight named the next source while the frame still showed the previous one. Only `backendSource`
  advances now; `activeSource` follows when the new state arrives. Verified with 261 samples across a
  two-source run: **0** label/page mismatches (status line still says "Opening <source>…" while it loads).
- **The agent stopped after the first screen of results.** The goal said "Stop only when matching rental
  results are visibly loaded", and the policy allowed DONE as soon as cards were visible — so a source was
  "done" in ~3 actions. The goal now asks to collect as many listings as possible (scroll for further
  cards, then keep advancing pages while more exist), and the policy adds: collecting is not finished at
  the first screen, prefer reaching unexplored results over re-opening a control already applied, and only
  choose DONE once further results are no longer reachable. The per-source turn budget went 24 → 40.
  Measured effect on a two-source run: **61 actions / 30 pages** (was ~3 actions / 1 page), 4 matches and
  17 to review, 1m 20s, $0.0318.
- **Caveat, deliberately not papered over:** `snapshot.js` reads *result cards*. Visiting a listing's detail
  page changes the URL and is counted as a page visited, but it does not yet add fields (beds/baths/sqft/
  description) to `collected_listings`, so those extra visits widen coverage more than they deepen it.
  Turning them into data is the P1 "detail-page enrichment" item in `TODO.md`.
- Exploring further costs more: the same two-source run spent $0.0318 versus $0.0026 for one short source.

## Listing detail enrichment (bounded, model-free)

The exploration pass visits listing pages, but `snapshot.js` only read *result cards*, so those visits
added no data. Enrichment is now a bounded read-only pass that costs **zero model calls**:

- `snapshot.js` returns a `detail` object when the current path is a listing page: title, price, address
  (when the page uses `<address>`), beds, baths, sqft, posted date, the listing's own description prose,
  and amenity keywords. The scan includes the `<h1>` and `<title>` because the model-facing text is capped
  and the heading is where the dense facts live. The description is the *tightest* block holding ≥200
  characters of prose, with page chrome excluded.
- `Agent.command("visit", {url})` navigates the existing agent to one already-observed http(s) URL and
  re-observes. It makes no model call and cannot open an unobserved page.
- After each source finishes, `enrichCollected()` opens up to **3 candidates that will actually be shown**
  (qualified first, then pending) — not the first cards on the page, which may be excluded. A blocked or
  rate-limited listing keeps the card it already had.
- `mergeDetail()` (pure, tested) reconciles the two views: the listing's own page wins on beds/baths/sqft/
  address, but a **settled card price is never replaced** by a page price (a page can show another unit's
  "starting at"), and a readable card date is never replaced by a page phrase.
- Cards now render the address, up to three amenity chips, and the source description.

Two bugs found by measuring rather than assuming:

- Enrichment first targeted the *first* cards collected, which were among the excluded ones — nothing
  enriched ever reached the report. It now targets the displayed candidate set.
- Enriched cards regressed to `? Listing date unknown`: the card's `<time>` text is truncated
  ("about 16"), which the age parser could not read, and it never fell back to the card text that
  carried the real `9/20`. `listingAgeDays` now tries `posted_text` **and** the card text, and month names
  ("September 20") parse like `9/20`.

Verified on a live run: 3 enriched listings with real beds/baths/sqft/description/amenities, 6 cards
rendering amenities + descriptions, recency badges back to `✓ Recent listing`, `errors: []`, and no
increase in model calls.

## End-of-source messages say what happened

The old rail message merged three different outcomes into one sentence — "Partial coverage — no further
supported progress or the action limit was reached" — so you could not tell whether the agent gave up or the
step budget ran out. `describeStop()` (pure, tested) now distinguishes them:

- `Finished browsing this source; listing checks are separate.`
- `Stopped on request; the page was left as it was.`
- `Ran out of steps (40) before finishing — some results may be missing.`
- `This source stopped early — nothing else on the page could advance the search.`

`runAutomatically` records whether it exhausted `maxTurns` (`budgetSpent`) instead of letting both cases
collapse into `blocked`. Verified live on both reachable branches: a Craigslist run that finished, and a
Zillow run that stopped early ("Finished early · 0 matches · 1 source checked", tab `ZillowPartial`).

## Interstitial pages are named, not guessed

A full four-source run showed Redfin returning a page titled **"Human Verification"** — reported as the
generic "stopped early" with 0 cards, indistinguishable from "no matches". `classifyPage()` (pure, tested)
now recognises three walls from the page title/text:

- `challenge` → "bot check" (human verification, captcha, unusual traffic, "just a moment")
- `signin` → "sign-in wall" (session expired, "sign in to continue")
- `ratelimit` → "rate limit" (too many requests, temporarily blocked)

It matches continuity phrasing only, so an ordinary page with a "Sign In" button is not a wall — there are
tests for exactly that. `describeStop()` reports a wall ahead of the generic partial message, and the source
tab takes the wall's own state (`Redfin Bot check`, with an alert dot) instead of "Partial".

Verified live on Redfin, which reproduced the wall: the rail read "This source showed a bot check and was
left alone; try it again later." and the tab read `Redfin Bot check`.

## Why sources showed "Failed" (and what it actually meant)

"Failed" was never a search outcome — it was the per-source `catch` firing, i.e. code threw. Two real
causes, both fixed:

- **A legitimate model outcome was raised as an exception.** When Jev picked a text field and then chose
  "none" for `type_text_value_N` ("nothing in my request belongs in this field"), `model.choose` raised,
  which aborted the source and marked it Failed. That is an outcome, not a break: `NoTextValue` is now
  caught in `Agent.command("predict")`, the source stops as **partial**, and `runAutomatically` breaks on a
  terminal status right after predicting. Covered by
  `test_a_field_with_no_supplied_value_stops_as_partial_not_failed`.
- **The harness's 5 s IPC deadline.** Facebook Marketplace is heavy enough that `Runtime.evaluate` exceeded
  it ("timed out after 5s waiting for the daemon"), which also surfaced as Failed. `cdp_call` now sets a
  25 s deadline.
- A third, environmental cause is now messaged instead of looking like a site failure: restarting the
  server re-issues the per-process demo token, so an already-open tab gets 403 → "The server restarted. Your
  partial results are saved; refresh to reconnect."

The browser layer is now **driven through the harness daemon** rather than holding a CDP session id:
`new_tab`/`close_tab` own the tab, raw calls go to the daemon's current tab, and a discarded tab is
reopened on the same URL (`Browser.reopen`, bounded) instead of becoming a stale-session error. A CDP
error dict is also unwrapped so `-32001 / Session with given id not found` reads as a sentence.

Caveat worth knowing: the daemon tracks **one** current tab, so a second client (a probe, a script) that
creates its own `Browser` while the app is driving will steal it. Verification scripts must attach to the
Hearth tab explicitly (`js(..., target_id=...)`).

Verified on a live Craigslist + Facebook run: **no Failed tabs** (Craigslist `Finished` with 41 collected,
Facebook `Partial` with 43), `Finished early · 9 matches`, `errors: none`.

Zillow, separately, served a **"Press & Hold to confirm you are a human"** challenge. The app detects and
labels it (`Zillow Bot check` + "This source showed a bot check and was left alone"), which is the honest
limit: it cannot and should not solve the challenge. Clearing it needs a human in that Chrome window.

Two more "looks stuck" causes were fixed alongside:

- **The dock kept its last mid-run phrase after the batch finished.** `renderCompletion()` now writes a
  final summary (`Search finished — N matches to review`, `Open the results below`, `DONE`) once the run is
  done and nothing is in flight. Verified: the dock reads `SEARCH SUMMARY · Search finished — 10 matches to
  review`.
- **A frame/address from the previous source could linger.** `render()` only ever assigned a new screenshot,
  so a state without one kept the last source's image; the address bar had the same problem. Both are now
  cleared when the current state has no page, so the frame can never show a different site than the active
  tab.

## Facebook Marketplace: collects well, converts poorly

Measured on a live Facebook-only run (59 collected):

- **Its card text runs the price into the title** (`"$2,950Modern 1 Private Bedroom Apartment"`), so
  `\$[\d,]+` swallowed the next digit and produced prices like `$3,6501`, `$4,0001` and beds like
  `"6501 Bed"`. That corrupted both the displayed price and the client-side price filter, wrongly dropping
  in-budget listings. `pricePattern` now requires comma groups of exactly three digits, and bed/bath counts
  are capped at two digits. Verified live: `$3,650`, `$4,000`, `$5,950`, `$750` and `1 Bed` / `2 Beds`.
- **Facebook's cards rarely carry the facts the checks need**: of the kept listings, `home` was unknown on
  all of them, `recency` unknown on 27 of 29, `location` unknown on 25 of 29. With an all-four-checks rule
  that means Facebook almost never produces a *confirmed* match, even though it contributes the most
  candidates of any source. This is a data-availability limit, not a bug: the card simply does not state
  the unit type or posting date.
- The page text was empty until the visibility fallback above; Facebook now acts (7 actions, was 0).
- Many Facebook results are rooms ("Private room for rent, $2,999"), which are excluded by design.

## Hosting beyond loopback

`TYPESAFE_DEMO_HOST` selects the bind interface (default `127.0.0.1`). Setting it to `0.0.0.0` makes the UI
reachable from another device, and the server prints a warning when it is. `host_allowed()` accepts the
configured host plus the loopback aliases (or, under a wildcard bind, any host on the port), and
`origin_allowed()` requires a mutation to be same-origin or to come from a non-browser client. Those guards
still reject a foreign `Origin` and a wrong token with 403, and path traversal with 404 — verified from the
LAN address. What a network bind does expose is the token itself, readable from `GET /`, so anyone who can
reach the port can drive the agent. The agent's own CDP port stays loopback-only.

## Important implementation notes

- `jev_ultrafast/demo.py` owns the local server and source start URLs.
- `jev_ultrafast/agent.py` owns the bounded Jev decision/execution loop.
- `jev_ultrafast/model.py` creates TypeSafe operation, target, and supplied-text choice heads.
- `jev_ultrafast/questions.py` contains the browsing policy and completion rules.
- `jev_ultrafast/browser.py` executes only observed DOM-node actions through Browser Harness/CDP.
- `jev_ultrafast/snapshot.js` captures visible controls and extracts generic listing-card metadata.
- `jev_ultrafast/static/app.js` orchestrates the autonomous multi-source sequence, UI source tabs, voice
  search, cached source states, and the final report.
- `jev_ultrafast/static/report.js` holds the DOM-free report logic (price bounds, home-type and
  private-room filtering, deduplication, completeness ranking, per-source balancing, URL escaping). The
  UI imports it and the offline Node tests exercise it directly.
- `jev_ultrafast/static/query.js` holds the DOM-free request parser that turns the top-bar text into
  sidebar filters (budget bounds/ranges/spoken numbers, home type, location) and the leftover preference.
  `static/backdrop.jpg`, `favicon.svg`, and `apple-touch-icon.png` ship with the app; `demo.py` serves the
  binary image assets as bytes, not through the text/`__TOKEN__` path.
- Previous source tabs are UI snapshots cached in the page. The backend owns one active browser agent at a
  time and closes the preceding controlled target when moving to a new source.

## Local run instructions

`TYPESAFE_API_KEY` is currently loaded from the user's interactive `~/.zshrc`; never print it or commit it.

```bash
cd /Users/chauhan/projects/jev-marketplace-search

# Start a dedicated Chrome debugging profile if port 9222 is not already available.
profile_path=$(mktemp -d /tmp/jev-hearth-chrome.XXXXXX)
open -na 'Google Chrome' --args \
  --remote-debugging-port=9222 \
  --user-data-dir="$profile_path" \
  --no-first-run --no-default-browser-check about:blank

# Start Hearth through an interactive zsh so TYPESAFE_API_KEY is inherited.
zsh -lic 'export BU_CDP_URL=http://127.0.0.1:9222; cd /Users/chauhan/projects/jev-marketplace-search; exec uv run jev'
```

Open <http://127.0.0.1:8766> in Google Chrome. Brave and some embedded Chromium browsers do not expose
the Web Speech API, so their microphone button will direct the user to Chrome.

## Security notes

- Never add Facebook cookies, TypeSafe keys, or Chrome-profile data to the repository.
- The Facebook cookies were pasted into the conversation and should be revoked/rotated by the user.
- Keep the server loopback-only. Its local mutation endpoints require the generated demo token.
- Continue to treat page text as untrusted input and execute only observed, freshness-checked actions.

