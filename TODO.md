# TODO for the next agent

Items are ordered by priority. Read `PROGRESS.md` first.

## P0 — finish live QA

- [x] Start dedicated Chrome on CDP port `9222`, then start Hearth through interactive `zsh` so
  `TYPESAFE_API_KEY` is inherited. (Chrome 153 was already on `9222`; server started with `BU_CDP_URL`.)
- [x] A real single-source Craigslist run through the UI reached `SEARCH COMPLETE`, rendered `Showing 18 of
  24`, and every displayed price was within `$2,000–$4,000` with no house-only or private-room card.
- [x] A fresh full four-source search completed with San Francisco, `$2,000–$4,000`, Flat, and Last four
  weeks: `Showing 18 of 60`, all 18 prices in range, and no JavaScript errors.
- [x] The header held `SEARCHING ALL SOURCES` through the run and the run ended in `Search complete`.
- [x] All four source tabs remained enabled/clickable after completion (Craigslist `done`; Facebook,
  Redfin, Zillow `checked`).
- [x] Inspected the 18 rendered cards of the four-source run: every source is represented and no
  private-room/share or house-only result appears for the Flat request.
- [x] Desktop and narrow responsive screenshots captured and inspected repeatedly after completed runs
  (1280×800 and 400×900) while checking the CTA position, rail height and report cards.

## P0 — improve report correctness and completeness

- [x] Fixed the generic listing extractor so Craigslist result cards are retained in `page.listings`. Cards
  now match `/view/d/<slug>/<token>`, prefer `.priceinfo`, dedupe by fragment-free href, and prefer a card
  `address`/heading for the title. Verified live: 24 cards with correct rent values.
- [x] Zillow cards remain represented; round-robin source balancing keeps every contributing source in the
  first 18 cards.
- [x] Explicit requested-filter and per-source badges are rendered in the report header.
- [x] Missing bedrooms/bathrooms/square footage render as `not provided`, distinct from a real zero value.
- [x] Deterministic tests for report filtering live in `tests/report.test.js` (price bounds, Flat-vs-House,
  private-room exclusion, URL escaping, deduplication, completeness sorting, source balancing,
  missing-metadata). Run with `node --test tests/report.test.js`.

## P1 — richer listing details

- [x] A bounded read-only enrichment pass now opens up to 3 displayed candidates per source after the
  search, capturing beds, baths, square feet, description, amenities and posted date with **zero model
  calls** (`Agent.command("visit")` + `mergeDetail()`). Full address still depends on the page exposing
  `<address>`, and lease terms are not extracted yet.
- [ ] Extract lease terms and the neighbourhood from detail pages, and rank against the user's optional
  natural-language preference with a typed TypeSafe decision rather than free-form prompt parsing.
- [ ] Add a concise “why it matches” summary derived only from observed facts; never invent missing details.

## P1 — source robustness

- [x] Interstitials are detected and reported with a concrete reason (`classifyPage()` →
  `challenge` / `signin` / `ratelimit`), reported ahead of the generic partial message, with the source tab
  taking that state (`Zillow Bot check`). Verified live on Redfin and Zillow. Cards already collected are
  retained.
- [x] Sources no longer report "Failed" for non-failures: a `NoTextValue` outcome stops the source as
  partial, and the harness IPC deadline went 5 s → 25 s (Facebook Marketplace was timing out).
- [x] The browser layer is driven through the harness daemon with no held session id; a discarded tab is
  reopened on the same URL. Raw CDP error dicts are unwrapped into sentences.
- [ ] Zillow serves a **"Press & Hold to confirm you are a human"** challenge. Detected and labelled, but not
  solvable by the app — clearing it needs a human in that Chrome window. Decide whether to keep Zillow
  enabled, warn before a run, or drop the source.
- [ ] Facebook: add a user-facing reauthentication **path** (the wall is detected and labelled, but there is
  no way to hand the user a signed-in browser).
- [ ] Facebook: verify date and property-type controls after login without relying on broad Marketplace
  search.
- [ ] Map “last four weeks” to the best available source control and label narrower substitutions such as
  Craigslist `posted today` in the report.

## P1 — real multi-tab backend

- [ ] Consider retaining one backend `Agent`/Chrome target per source instead of caching previous sources
  only in the frontend. This would make every UI source tab resume-capable.
- [ ] If implemented, key API state and commands by source, preserve the single-action lock per agent, and
  cap concurrency to avoid TypeSafe/API bursts.
- [ ] Keep the current sequential mode as a low-resource fallback.

## P2 — additional marketplaces

- [ ] Add Apartments.com: <https://www.apartments.com/san-francisco-ca/>.
- [ ] Add HotPads: <https://hotpads.com/san-francisco-ca/apartments-for-rent>.
- [ ] Add Zumper: <https://www.zumper.com/apartments-for-rent/san-francisco-ca>.
- [ ] Add Realtor.com rentals: <https://www.realtor.com/apartments/San-Francisco_CA>.
- [ ] Consider Trulia and local property-management sites after testing anti-bot behavior and listing
  quality. Avoid adding many duplicate feeds without source deduplication.

## P2 — UX and accessibility

- [x] Added `favicon.svg`, `apple-touch-icon.png`, description/OG/Twitter meta tags, and an illustrated
  landing backdrop with a translucent frosted UI. Voice/typed requests now fill the sidebar filters.
- [x] Two-state shell (nothing but setup before a search), CTA above the fold (947px → 716px at 1280×800),
  hero collapses when running, activity rail as event cards with cost/ms badges and a green current card,
  shareable search URL, Developer toggle (persisted), no user-facing text below 9px, humanized internal
  errors, and a fixed map-pin icon. The amber completion banner was replaced by a `Finished · N matches`
  status plus a **See the results ↓** button in the filter-chip row, and the zero-valued MATCHES tile was
  dropped from the metrics strip.
- [x] CDP drops (`no close frame received or sent`) no longer abort a run: idempotent calls retry once,
  mutations never replay (`tests/test_reliability.py`). Policy no longer burns the budget on the map/radius
  control or declares BLOCKED with results on screen (`tests/test_policy.py`).
- [x] A full four-source run completed after the CDP-retry and policy fixes: 4 sources checked, 2 matches,
  40 to review, 22 actions, 36.7s, no connection drop.
- [ ] Re-run the full four-source search once more: the verification above predates the later changes
  (result exploration, the 40-turn budget, the bounded enrichment pass, the run-summary rework).
- [ ] Add source-tab tooltips explaining `Complete` versus `Checked`.
- [ ] Announce source transitions and report completion through an ARIA live region.
- [ ] Add explicit recording/listening animation and permission guidance for Chrome voice search.
- [ ] Add a report export suitable for sharing (JSON/CSV first; PDF only if requested).
- [ ] Add loading skeletons for report cards and broken-image fallback handling.

## Before handing off or merging

```bash
uv run ruff check .
uv run pytest
node --check jev_ultrafast/static/app.js
node --check jev_ultrafast/snapshot.js
git diff --check
```

- [ ] Verify no credentials, cookies, traces, or temporary Chrome profiles are staged.
- [ ] Commit the handoff changes and push `main` to `origin`.
- [ ] Leave `upstream` pointing to `browser-use/jev-ultrafast` for future reference only.

