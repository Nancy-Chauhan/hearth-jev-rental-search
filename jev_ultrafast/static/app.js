import { parseSearchQuery } from "./query.js";
import { escapeHtml as escape, listingFacts, selectListings, canonicalListingUrl, mergeDetail } from "./report.js";
import { summarizeTelemetry, dollars, duration, actionCost, describeAction, describeStop, classifyPage, normalizeBudget, humanizeError, estimateCost, describeRate, compactTokens } from "./telemetry.js";

const $ = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="demo-token"]').content;

let state = null;
let busy = false;
let automatic = false;
let recognition = null;
let submitAfterVoice = false;
let activeSource = "craigslist";
let backendSource = null;
let batchCancelled = false;
let batchRunning = false;
const sourceStates = new Map();
const sourceProgress = new Map();
let run = null;
let runEvents = [];
let currentAction = "Ready when you are";
let report = null;
// Server-supplied rates live at module scope: a restored run carries its own stale
// snapshot, which must not pin the AI-spend tile to token totals.
let pricing = null;
const SESSION_KEY = "hearth-search-v2";
const HISTORY_KEY = "hearth-searches";
const DEVELOPER_KEY = "hearth-developer";
const sourceLabels = { queued: "Queued", working: "Searching", done: "Finished", blocked: "Partial", failed: "Failed", stopped: "Stopped", challenge: "Bot check", signin: "Needs sign-in", ratelimit: "Rate limited" };
const WALL_KINDS = ["challenge", "signin", "ratelimit"];

function formSettings() {
  return {
    location: $("location").value.trim(),
    minPrice: Number(numericValue("min-price")),
    maxPrice: Number(numericValue("max-price")),
    requestedType: document.querySelector('input[name="home-type"]:checked').value,
    daysListed: Number($("date-listed").value),
    dateLabel: $("date-listed").selectedOptions[0].textContent,
    preference: $("goal").value.trim(),
  };
}

function syncUrl(settings) {
  const params = new URLSearchParams();
  // The search id makes every search addressable: ?s=<uuid> plus its filters.
  if (run?.id) params.set("s", run.id);
  params.set("location", settings.location);
  params.set("min", String(settings.minPrice));
  params.set("max", String(settings.maxPrice));
  params.set("type", settings.requestedType);
  params.set("days", String(settings.daysListed));
  params.set("sources", runSources.join(","));
  if (settings.preference) params.set("q", settings.preference);
  history.replaceState(null, "", `?${params}`);
}

// Every search gets a stable id, kept in localStorage so it can be revisited.
function rememberSearch() {
  if (!run) return;
  try {
    const previous = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    const entry = {
      id: run.id,
      startedAt: run.startedAt,
      location: run.settings.location,
      minPrice: run.settings.minPrice,
      maxPrice: run.settings.maxPrice,
      requestedType: run.settings.requestedType,
      preference: run.settings.preference,
      sources: [...runSources],
    };
    const kept = [entry, ...(Array.isArray(previous) ? previous : []).filter(item => item?.id !== run.id)].slice(0, 20);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(kept));
  } catch { /* Storage can be unavailable; the search still runs. */ }
}

// A search link is shareable: the same URL rebuilds the same request.
function applyUrlSettings() {
  const params = new URLSearchParams(location.search);
  if (!params.size) return false;
  const amount = (value) => {
    const parsed = Number(String(value ?? "").replace(/[^0-9]/g, ""));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  if (params.get("location")) $("location").value = params.get("location");
  if (params.get("q")) $("goal").value = params.get("q");
  const min = amount(params.get("min"));
  const max = amount(params.get("max"));
  if (min != null) $("min-price").value = min.toLocaleString("en-US");
  if (max != null) $("max-price").value = max.toLocaleString("en-US");
  const type = params.get("type");
  if (type) {
    const radio = document.querySelector(`input[name="home-type"][value="${type}"]`);
    if (radio) radio.checked = true;
  }
  if (["1", "7", "30"].includes(params.get("days"))) $("date-listed").value = params.get("days");
  const chosen = (params.get("sources") || "").split(",").filter(name => sources[name]);
  if (chosen.length) {
    for (const input of document.querySelectorAll('input[name="source"]')) input.checked = chosen.includes(input.value);
  }
  return true;
}

function saveRun() {
  if (!run) return;
  run.savedAt = Date.now();
  try {
    const states = [...sourceStates].map(([source, data]) => [source, {
      ...data,
      page: data.page ? { ...data.page, screenshot: undefined, text: "", actions: [], guards: {}, marker: null } : null,
      decision: null,
      decisions: (data.decisions || []).map(({ request, raw_answers, ...decision }) => decision),
      elements: [],
    }]);
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ run, events: runEvents, states, progress: [...sourceProgress], sources: runSources, activeSource }));
  } catch { /* Storage can be unavailable or full; the active search still works. */ }
}

function notice(message, kind = "notice", source = activeSource) {
  runEvents.push({ id: crypto.randomUUID(), at: Date.now(), message, kind, source });
}

function acceptState(source, data) {
  const previous = sourceStates.get(source);
  const collected = new Map((previous?.collected_listings || []).map(item => [canonicalListingUrl(item.href), item]));
  for (const item of data.page?.listings || []) {
    const key = canonicalListingUrl(item.href);
    const old = collected.get(key);
    collected.set(key, { ...old, ...item, image: item.image || old?.image || "" });
  }
  // The page the agent is looking at may be a single listing's own page.
  const detail = data.page?.detail;
  if (detail && data.page?.url) {
    const key = canonicalListingUrl(data.page.url);
    const old = collected.get(key) || { href: data.page.url, source, title: detail.title || "", summary: "" };
    collected.set(key, mergeDetail(old, detail));
  }
  data.collected_listings = [...collected.values()];
  data.visited_pages = [...new Set([...(previous?.visited_pages || []), data.page?.url].filter(Boolean))];
  sourceStates.set(source, data);
  state = data;
  activeSource = source;
  saveRun();
}


const sources = {
  craigslist: { name: "Craigslist", address: "craigslist.org/search/city/san-francisco-ca · 4.8 mi" },
  marketplace: { name: "Facebook Marketplace", address: "facebook.com/marketplace" },
  redfin: { name: "Redfin", address: "redfin.com/San-Francisco/apartments-for-rent" },
  zillow: { name: "Zillow", address: "zillow.com/san-francisco-ca/rentals" },
};
let runSources = Object.keys(sources);

const percent = (value) =>
  value == null ? "—" : `${(value * 100).toFixed(value < 0.01 ? 1 : 0)}%`;

const plural = (count, word, pluralWord = `${word}s`) => `${count} ${count === 1 ? word : pluralWord}`;

const delay = (milliseconds) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

// The Developer toggle is a local preference that survives reloads. Storage can be
// unavailable (private mode, disabled cookies), so every access is guarded and the
// default is always off.
function readDeveloperPreference() {
  try { return localStorage.getItem(DEVELOPER_KEY) === "1"; }
  catch { return false; }
}

function saveDeveloperPreference(on) {
  try { localStorage.setItem(DEVELOPER_KEY, on ? "1" : "0"); }
  catch { /* Storage unavailable; the toggle still applies for this session. */ }
}

function numericValue(id) {
  return $(id).value.replace(/[^0-9]/g, "");
}

function buildGoal(source = activeSource) {
  const settings = run?.settings || formSettings();
  const type = settings.requestedType === "flat" ? "apartment" : settings.requestedType;
  return [
    `Search ${sources[source].name} rental listings for a ${type} in ${settings.location}.`,
    `Set the monthly price between $${settings.minPrice} and $${settings.maxPrice}, and show listings from the ${settings.dateLabel.toLowerCase()}.`,
    settings.preference ? `The user's additional preference is: ${settings.preference}.` : "",
    "Apply every requested filter before reviewing results.",
    "Then collect as many matching listings as possible: scroll the results so more cards load, and keep",
    "advancing to further pages of results while more pages exist.",
    "Do not stop after the first screen of results, and do not re-open a filter you have already applied.",
    "Do not message sellers, save listings, or start a transaction.",
  ].filter(Boolean).join(" ");
}

function buildTextValues() {
  const settings = run?.settings || formSettings();
  const values = {
    location: { value: settings.location, description: "The requested city or location for the rental search." },
    minimum_monthly_price: { value: String(settings.minPrice), description: "The minimum monthly rental price, without a currency symbol." },
    maximum_monthly_price: { value: String(settings.maxPrice), description: "The maximum monthly rental price, without a currency symbol." },
    home_type: { value: settings.requestedType === "flat" ? "apartment" : settings.requestedType, description: "The requested kind of home or rental property." },
  };
  if (settings.preference) values.search_preference = { value: settings.preference, description: "The user's exact search preference." };
  return values;
}

async function call(name, body = {}, attempt = 0) {
  const source = backendSource || activeSource;
  const response = await fetch(`/api/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Demo-Token": token },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  // A 409 rejects before execution. Never retry an ambiguous mutation failure.
  if (response.status === 409 && attempt < 8 && !batchCancelled) {
    await delay(350);
    return call(name, body, attempt + 1);
  }
  if (!response.ok) {
    const error = Error(response.status === 403 ? "The server restarted. Your partial results are saved; refresh to reconnect." : data.error || "Request failed");
    error.status = response.status;
    throw error;
  }
  if (data.pricing) pricing = data.pricing;
  acceptState(source, data);
  render();
  return data;
}

function setActivity(label, detail = "") {
  currentAction = label;
  $("status").textContent = label;
  if (detail) $("choice-title").textContent = detail;
}

let hintTimer = null;

// A short-lived inline note under the search field. Persisted while the mic is open.
function setHint(message, persist = false) {
  const node = $("voice-hint");
  node.textContent = message;
  node.classList.toggle("visible", Boolean(message));
  if (hintTimer) window.clearTimeout(hintTimer);
  hintTimer = !message || persist ? null : window.setTimeout(() => {
    node.classList.remove("visible");
    node.textContent = "";
  }, 9000);
}

function showError(message) {
  $("error").textContent = message;
  $("error").hidden = false;
}

function clearError() {
  $("error").textContent = "";
  $("error").hidden = true;
}

function controls() {
  const terminal = ["done", "blocked"].includes(state?.status);
  const inspectOnly = Boolean(state?.page && activeSource !== backendSource);
  const live = state?.page && !terminal && !inspectOnly;
  const configured = state?.configuration?.typesafe;
  $("start").disabled = busy || !configured;
  $("new-search").disabled = busy || !configured;
  $("edit-search").disabled = busy;
  $("search-submit").disabled = busy || !configured;
  $("voice").disabled = busy;
  for (const field of document.querySelectorAll('#task-form input, #task-form select, #goal')) field.disabled = busy;
  $("choose").disabled = busy || !live;
  $("execute").disabled = busy || !state?.decision || !live;
  $("auto").disabled = busy || !live;
  $("auto").hidden = automatic || batchRunning || !live;
  $("stop").hidden = !(batchRunning || automatic);
  $("stop").disabled = batchCancelled;
  $("stop").textContent = batchCancelled ? "Stopping…" : "Stop search";
  $("download").disabled = !sourceStates.size;
  $("status-dot").classList.toggle("working", busy || automatic);
  $("activity-mode").textContent = busy ? "SEARCH IN PROGRESS" : run?.finishedAt ? "SEARCH SUMMARY" : "JEV IS READY";
  document.body.classList.toggle("has-run", Boolean(run));
  document.body.classList.toggle("is-searching", busy);
}

function renderSourceTabs() {
  $("source-tabs").hidden = !run;
  $("source-tabs").innerHTML = runSources.map(source => {
    const progress = sourceProgress.get(source) || "queued";
    const enabled = Boolean(sourceStates.get(source)?.page) && !busy;
    return `<button class="source-tab ${source === activeSource ? "active" : ""} ${escape(progress)}" data-source="${source}" ${enabled ? "" : "disabled"} aria-label="${escape(sources[source].name)}: ${sourceLabels[progress]}"><span class="tab-dot"></span>${escape(sources[source].name)}<small>${sourceLabels[progress]}</small></button>`;
  }).join("");
}

async function recoverState() {
  // Read-only recovery can preserve a logged action whose response was lost.
  try {
    const response = await fetch("/api/state", { signal: AbortSignal.timeout(4000) });
    const fresh = await response.json();
    if (fresh.run_id && fresh.run_id === sourceStates.get(backendSource)?.run_id) acceptState(backendSource, fresh);
  } catch { /* Keep the last good source snapshots. */ }
}

async function perform(work, label) {
  if (busy) return;
  busy = true;
  clearError();
  setActivity(label);
  controls();
  try { await work(); }
  catch (error) {
    automatic = false;
    await recoverState();
    notice(humanizeError(error.message), "error");
    showError(humanizeError(error.message));
    setActivity("Search interrupted — partial results retained");
  } finally {
    busy = false;
    controls();
    render();
  }
}

const ENRICH_LIMIT = 3;

// Deterministic and model-free: open a few already-collected listings read-only so the
// facts their result card could not show (beds, size, description, amenities) join the card.
// Targets the candidates that will actually be shown, most-likely-first, and a blocked or
// rate-limited listing simply keeps the card it already had.
async function enrichCollected(source, limit = ENRICH_LIMIT) {
  const candidates = [...(report?.qualified || []), ...(report?.pending || [])]
    .filter(item => item.source === source && item.href && !item.enriched);
  const seen = new Set();
  const targets = candidates.filter(item => !seen.has(item.key) && seen.add(item.key)).slice(0, limit);
  for (const listing of targets) {
    if (batchCancelled) break;
    setActivity("Reading a listing in full…", listing.title || listing.href);
    try {
      await call("visit", { url: listing.href });
    } catch { /* Keep the card we already have for this listing. */ }
  }
  return targets.length;
}

async function runAutomatically(maxTurns = 40) {
  automatic = true;
  controls();
  for (let step = 0; step < maxTurns && automatic && !batchCancelled; step += 1) {
    setActivity("Reading the page and choosing the next step…");
    await call("predict");
    // A prediction can end the source by itself (e.g. Jev found no value for the field it picked).
    if (["done", "blocked"].includes(state.status)) break;
    if (!automatic || batchCancelled) break;
    const selected = state.decision;
    const action = state.page.actions.find(item => item.id === selected?.choice);
    setActivity(action ? describeAction({ ...action, text: selected.text }, true)
      : selected?.choice === "DONE" ? "Finishing this source…" : "Checking why this source cannot continue…");
    await call("act", { fingerprint: state.page.fingerprint });
    if (["done", "blocked"].includes(state.status)) break;
    // A verification wall is not something to keep clicking at; stop this source now.
    if (classifyPage(state.page)) break;
  }
  automatic = false;
  // Distinguish "the agent said it could go no further" from "we ran out of turns" and
  // from "the site put a wall in front of us".
  const budgetSpent = !batchCancelled && !["done", "blocked"].includes(state.status);
  const progress = batchCancelled ? "stopped" : state.status === "done" ? "done" : "blocked";
  const wall = progress === "blocked" ? classifyPage(state.page) : null;
  // Say why this source produced no confirmed match: nothing kept, or kept but unconfirmed.
  const pending = report?.pending || [];
  const mine = pending.filter(item => item.source === backendSource);
  const contributed = (report?.qualified || []).some(item => item.source === backendSource) || mine.length;
  const excluded = contributed ? null : (report?.excluded || [])
    .filter(item => item.source === backendSource).map(item => item.reason);
  const unconfirmed = contributed ? mine : null;
  // A wall gets its own tab state, so the tab does not read as an ordinary partial result.
  sourceProgress.set(backendSource, wall ? wall.kind : progress);
  notice(describeStop(progress, { budgetSpent, maxTurns, blocked: wall, excluded, pending: unconfirmed }),
    progress, backendSource);
  saveRun();
  render();
}

function renderTargets(page, decision) {
  const targets = new Map();
  for (const action of page.actions) {
    if (action.rect && !targets.has(action.node)) targets.set(action.node, action);
  }
  const selectedIndex = decision?.target?.split(":")[0];
  $("targets").innerHTML = [...targets.values()]
    .map((action, index) => {
      const elementIndex = String(index + 1);
      return `<div class="target ${elementIndex === selectedIndex ? "selected" : ""}" data-action="${elementIndex}" style="left:${(100 * action.rect.x) / page.w}%;top:${(100 * action.rect.y) / page.h}%;width:${(100 * action.rect.w) / page.w}%;height:${(100 * action.rect.h) / page.h}%"><span>${elementIndex}</span></div>`;
    })
    .join("");
  $("targets").hidden = !$("overlays").checked;
}

function renderTechnicalState(page, decision) {
  const probability = (element) =>
    decision?.target_probabilities[element.index] ??
    Math.max(
      -1,
      ...(element.options || []).map(
        (option) => decision?.target_probabilities[option.index] ?? -1,
      ),
    );
  const selectedIndex = decision?.target?.split(":")[0];
  const elements = [...state.elements];
  if (decision) elements.sort((left, right) => probability(right) - probability(left));
  $("choices").innerHTML = elements
    .map((element) => {
      const value = probability(element);
      return `<div class="choice ${selectedIndex === element.index ? "best" : ""}" data-action="${escape(element.index)}"><span class="choice-id">[${escape(element.index)}]</span><div class="choice-label">${escape(element.label)}<small>${escape(element.role)} · ${escape(element.operations.join(" / "))}${element.value ? ` · ${escape(element.value)}` : ""}</small>${value >= 0 ? `<div class="bar" style="--probability:${value * 100}%"></div>` : ""}</div><span class="probability">${value >= 0 ? percent(value) : "—"}</span></div>`;
    })
    .join("");
  $("model-state").textContent = JSON.stringify(
    decision?.request || {
      goal: state.goal,
      url: page.url,
      text: page.text,
      actions: page.actions.map(({ rect, node, ...rest }) => rest),
    },
    null,
    2,
  );
}

function safeUrl(value) {
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : ""; }
  catch { return ""; }
}

function imageMarkup(listing) {
  const image = safeUrl(listing.image);
  return `<div class="listing-photo${image ? "" : " placeholder"}">${image ? `<img src="${escape(image)}" alt="${escape(listing.title)}" loading="lazy" referrerpolicy="no-referrer" />` : '<span class="photo-fallback">⌂<small>Photo unavailable</small></span>'}<span class="listing-source">${escape(sources[listing.source]?.name || listing.source)}</span></div>`;
}

function checkBadges(listing) {
  const labels = { price: "Price fits", location: "City matches", home: "Home type fits", recency: "Recent listing" };
  const unknown = { price: "Unit price unconfirmed", location: "City unconfirmed", home: "Entire unit unconfirmed", recency: "Listing date unknown" };
  return Object.entries(listing.checks || {}).map(([key, value]) => `<span class="check-badge ${value}">${value === "pass" ? "✓ " + labels[key] : "? " + unknown[key]}</span>`).join("");
}

function listingCard(listing, index = null) {
  const amenities = (listing.amenities || []).slice(0, 3).map(word => `<span class="amenity">${escape(word)}</span>`).join("");
  const facts = listingFacts(listing).filter(fact => fact.available).map(fact => `<span>${escape(fact.value)}</span>`).join("") + amenities;
  const address = listing.address ? `<span class="listing-address">${escape(listing.address)}</span>` : "";
  const description = listing.description ? `<p class="listing-summary">${escape(listing.description)}</p>` : "";
  const savings = (run?.settings.maxPrice || 0) - listing.priceValue;
  const reason = listing.checks?.price === "pass" && savings > 0
    ? `$${savings.toLocaleString("en-US")} below your monthly budget`
    : listing.checks?.price === "pass" ? "Within your monthly budget" : "Starting price — confirm the available unit";
  return `<article class="listing-card">${index != null ? `<span class="shortlist-number">0${index + 1}</span>` : ""}<a href="${escape(safeUrl(listing.href))}" target="_blank" rel="noopener noreferrer">${imageMarkup(listing)}<div class="listing-body"><strong class="listing-price">${escape(listing.price)}<small> monthly rent</small></strong><span class="listing-title">${escape(listing.title)}</span>${address}<div class="listing-facts">${facts || '<span>Details not provided</span>'}</div><p class="match-reason">${escape(reason)}</p>${description}<div class="listing-checks">${checkBadges(listing)}</div><span class="listing-link">View original listing ↗</span></div></a></article>`;
}

function updateNumber(id, value) {
  const node = $(id);
  if (node.textContent === String(value)) return;
  node.textContent = value;
  node.classList.remove("number-tick");
  requestAnimationFrame(() => node.classList.add("number-tick"));
}

function renderClock() {
  if (!run) return;
  const elapsed = Math.max(0, (run.finishedAt || Date.now()) - run.startedAt);
  $("metric-time").textContent = elapsed < 60000 ? `${(elapsed / 1000).toFixed(1)} s` : `${Math.floor(elapsed / 60000)}m ${Math.floor(elapsed % 60000 / 1000)}s`;
  const age = state?.page?.captured_at ? Math.max(0, Math.floor((Date.now() - state.page.captured_at) / 1000)) : null;
  $("browser-live").querySelector("span").textContent = state?.page?.screenshot ? `${busy ? "FRAME" : "LAST FRAME"}${age != null ? ` · ${age}s` : ""}` : "WAITING";
  $("browser-live").classList.toggle("offline", !busy || age == null || age > 5);
}

// Spend is reported in USD only when the provider says so. Token totals and an
// operator-configured estimate are shown instead of an empty dash.
function spendMetric(stats) {
  const tokens = stats.tokens.input + stats.tokens.output;
  const calls = plural(stats.calls, "model call");
  if (stats.cost != null) {
    return {
      label: "AI spend · USD",
      value: `${dollars(stats.cost)}${stats.costComplete ? "" : "+"}`,
      note: stats.costComplete ? `Provider-reported cost · ${calls}` : `${stats.knownCalls}/${stats.calls} calls priced; subtotal`,
    };
  }
  const estimate = estimateCost(stats.tokens, pricing || state?.pricing);
  if (estimate != null) {
    const rate = describeRate(pricing || state?.pricing);
    return {
      label: "AI spend · USD",
      value: dollars(estimate),
      note: `${compactTokens(tokens)} tokens${rate ? ` at ${rate}` : ""} · estimate`,
    };
  }
  if (tokens > 0) {
    return { label: "Model tokens", value: compactTokens(tokens), note: `Provider reports tokens, not USD · ${calls}` };
  }
  return { label: "AI spend · USD", value: "—", note: "No model calls yet" };
}

function renderMetrics() {
  const stats = summarizeTelemetry(sourceStates);
  updateNumber("metric-pages", stats.pages);
  $("metric-sources").textContent = run ? `${sourceStates.size} of ${runSources.length} sources visited` : "Across your selected sources";
  updateNumber("metric-actions", stats.actions);
  $("metric-calls").textContent = `${plural(stats.clicks, "click")} · ${plural(stats.calls, "model call")}`;
  const spend = spendMetric(stats);
  $("metric-cost").textContent = spend.value;
  $("metric-cost-label").textContent = spend.label;
  $("metric-cost-note").textContent = spend.note;
  $("step-count").textContent = `${plural(stats.actions, "action")} across this search`;
  renderClock();
}

function replaceStream(id, html) {
  const node = $(id);
  if (node.dataset.rendered === html) return;
  const expanded = [...node.querySelectorAll("details[open]")].map(item => item.dataset.event);
  const top = node.scrollTop, previousHeight = node.scrollHeight;
  node.innerHTML = html;
  node.dataset.rendered = html;
  for (const item of node.querySelectorAll("details")) if (expanded.includes(item.dataset.event)) item.open = true;
  if (top > 12) node.scrollTop = top + Math.max(0, node.scrollHeight - previousHeight);
}

const ACTIVITY_LIMIT = 15;

function eventCard(item) {
  const source = sources[item.source]?.name || "Search";
  if (item.kind !== "action") {
    return `<article class="event-card ${escape(item.kind)}"><span class="event-dot"></span><div class="event-body"><strong>${escape(item.message)}</strong><div class="event-meta"><span>${escape(source)}</span></div></div></article>`;
  }
  const cost = actionCost(item);
  const total = item.total_ms ?? item.latency_ms;
  const outcome = item.page_changed === true ? "Page changed" : item.page_changed === false ? "No page change" : "Outcome unconfirmed";
  const value = item.text_source === "supplied" ? " · supplied value" : item.text_source === "reused" ? " · reused text" : "";
  return `<article class="event-card action">
    <span class="event-dot"></span>
    <div class="event-body">
      <div class="event-line">
        <strong>${escape(describeAction({ ...item, kind: item.browserKind || item.kind }))}</strong>
        <div class="event-badges">
          <span class="event-badge${cost == null ? " muted" : ""}" title="${cost == null ? "Provider did not report USD cost" : "Reported model cost for this action"}">${escape(dollars(cost))}</span>
          <span class="event-badge time" title="Decision, text generation and browser input">${escape(duration(total))}</span>
        </div>
      </div>
      <div class="event-meta"><span>${escape(source)}</span><span>${escape(item.model || "model not reported")}${value}</span><span class="event-outcome">${escape(outcome)}</span></div>
      <details class="event-detail" data-event="${escape(item.id || "")}"><summary>Timing breakdown</summary><div class="timing-grid"><span>Decision</span><b>${duration(item.latency_ms)}</b><span>Text generation</span><b>${duration(item.text_latency_ms)}</b><span>Browser input</span><b>${duration(item.browser_ms)}</b><span>Page observation</span><b>${duration(item.observation_ms)}</b></div><p>Total includes decision and execution, excluding presentation pauses.</p></details>
    </div>
  </article>`;
}

function currentEventCard() {
  const source = sources[backendSource || activeSource]?.name || "Search";
  const model = state?.decision?.model;
  return `<article class="event-card action current"><span class="event-dot"></span><div class="event-body"><div class="event-line"><strong>${escape(currentAction)}</strong><div class="event-badges"><span class="event-badge live">now</span></div></div><div class="event-meta"><span>${escape(source)}</span>${model ? `<span>${escape(model)}</span>` : ""}</div></div></article>`;
}

function renderActivity() {
  const events = [...runEvents];
  for (const [source, data] of sourceStates) {
    for (const item of data.history || []) {
      events.push({ ...item, browserKind: item.kind, source, kind: "action", id: `${source}:${data.run_id}:${item.step}`, at: item.at || run?.startedAt || 0 });
    }
  }
  events.sort((a, b) => b.at - a.at);
  const shown = events.slice(0, ACTIVITY_LIMIT);
  $("activity-count").textContent = events.length > shown.length
    ? `latest ${shown.length} of ${plural(events.length, "event")}`
    : plural(events.length, "event");
  const cards = (busy && currentAction ? [currentEventCard()] : []).concat(shown.map(eventCard));
  replaceStream("history", cards.join("") || '<p class="stream-empty">The clicks, the checks, the discoveries.<br />Follow every step here.</p>');
  const excluded = report?.excluded || [];
  $("filter-count").textContent = excluded.length;
  const pending = report?.pending || [];
  replaceStream("filter-history", [...excluded.map(item => `<div class="stream-event excluded"><span class="stream-dot"></span><strong>${escape(item.reason)}</strong><p>${escape(item.title)}</p><small>${escape(sources[item.source]?.name)}</small></div>`), ...pending.map(item => `<div class="stream-event"><span class="stream-dot"></span><strong>Needs another look</strong><p>${escape(item.title)}</p><div class="listing-checks">${checkBadges(item)}</div></div>`)].join("") || '<p class="stream-empty">Each candidate is checked against your price, city, home type and recency.</p>');
  $("filter-totals").textContent = run ? `${report?.scanned || 0} candidates seen · ${excluded.length} excluded · ${report?.qualified.length || 0} match listing checks` : "Only observed facts count. Missing details stay marked.";
}

function renderReport() {
  const settings = run?.settings || formSettings();
  report = selectListings({
    ...settings,
    groups: runSources.map(source => ({ source, listings: sourceStates.get(source)?.collected_listings || [] })),
  });
  const { listings, qualified, pending, matches } = report;
  $("report").hidden = !run;
  $("report-title").textContent = matches ? "The search, so far." : busy ? "Looking for your kind of place…" : "No matching candidates yet.";
  $("report-count").textContent = `${plural(qualified.length, "match", "matches")} · ${pending.length} to review`;
  $("report-context").textContent = matches ? "Matches pass price, city, home type and recency checks on the listing. Availability and accuracy still need confirmation with the source." : "Results appear here as the search progresses. Unknown facts never count as passed checks.";
  const type = settings.requestedType === "flat" ? "Apartment" : settings.requestedType;
  const chips = [settings.location, `Up to $${settings.maxPrice.toLocaleString("en-US")}/mo`, type, settings.dateLabel];
  $("report-badges").innerHTML = chips.map(label => `<span class="filter-badge">${escape(label)}</span>`).join("");
  $("search-chips").innerHTML = chips.map(label => `<span>${escape(label)}</span>`).join("");
  $("run-summary").hidden = !run;
  const html = listings.map(item => listingCard(item)).join("");
  if ($("report-grid").dataset.rendered !== html) {
    $("report-grid").innerHTML = html;
    $("report-grid").dataset.rendered = html;
  }
  const first = qualified.find(item => item.key === run?.firstMatchKey) || qualified[0];
  $("first-match").hidden = !first;
  if (first && run) {
    if (run.firstMatchKey !== first.key) { run.firstMatchKey = first.key; saveRun(); }
    const firstHtml = `${imageMarkup(first)}<div><p class="kicker">A PLACE THAT FITS YOUR FILTERS</p><strong>${escape(first.price)} · ${escape(first.title)}</strong><p>All four listing checks pass. Open the source to confirm availability.</p></div><a href="${escape(safeUrl(first.href))}" target="_blank" rel="noopener noreferrer">Take a look ↗</a>`;
    if ($("first-match").dataset.rendered !== firstHtml) { $("first-match").innerHTML = firstHtml; $("first-match").dataset.rendered = firstHtml; }
  }
  $("finale").hidden = !run?.finishedAt;
  if (run?.finishedAt) {
    const partial = runSources.some(source => sourceProgress.get(source) !== "done");
    $("finale-eyebrow").textContent = partial ? "YOUR PARTIAL SHORTLIST" : "YOUR SHORTLIST";
    $("finale-status").textContent = partial ? "Partial coverage" : "Browsing finished";
    $("finale-title").textContent = qualified.length ? "Start picturing yourself here." : pending.length ? "Promising places. A few details to check." : "Let's adjust the search.";
    $("finale-context").textContent = `${qualified.length} matches and ${pending.length} candidates to review. ${partial ? "Some sources could not finish; results are retained below." : "Selected sources finished browsing."} ${qualified.length ? "Ranked by completeness, then price. Confirm availability on the original listing." : "No candidate passed all four listing checks."}`;
    $("shortlist-grid").innerHTML = (qualified.length ? qualified : pending).slice(0, 3).map((item, index) => listingCard(item, index)).join("");
  }
}

function renderCompletion() {
  const done = Boolean(run?.finishedAt);
  if (!done) {
    $("run-status").textContent = "";
  } else {
    const partial = runSources.some(source => sourceProgress.get(source) !== "done");
    const qualified = report?.qualified?.length || 0;
    // The source tabs already carry per-source state, so this stays short enough for one line.
    $("run-status").textContent = `${partial ? "Finished early" : "Finished"} · ${plural(qualified, "match", "matches")}`;
    // The dock otherwise keeps the last mid-run phrase and reads as if it were still working.
    if (!busy && !automatic) {
      const summary = qualified
        ? `Search finished — ${plural(qualified, "match", "matches")} to review`
        : "Search finished — nothing confirmed yet";
      currentAction = summary;
      $("status").textContent = summary;
      $("choice-title").textContent = "Open the results below";
      $("completion").textContent = "DONE";
    }
  }
  $("completion-jump").textContent = report?.qualified?.length ? "Results ↓" : "What was found ↓";
  // Offer to pick a walled source back up once a human has cleared its check.
  const walled = WALL_KINDS.includes(sourceProgress.get(activeSource));
  $("retry-source").hidden = !walled || busy;
  if (walled) {
    $("retry-source").textContent = `Continue with ${sources[activeSource]?.name || "this source"}`;
    $("retry-source").title =
      `Clear the ${sources[activeSource]?.name || "site"} check in the browser window, then press this`;
  }
}

// A walled source can be picked up again once a human has cleared the check in the browser:
// the profile then carries the site's clearance, so reopening the source proceeds normally.
async function retrySource(source) {
  if (busy || !run || !source) return;
  await perform(async () => {
    backendSource = source;
    sourceProgress.set(source, "working");
    clearError();
    setActivity(`Reopening ${sources[source].name}…`);
    render();
    try {
      await call("reset", { scenario: source, goal: buildGoal(source), text_values: buildTextValues() });
      await runAutomatically();
      await enrichCollected(source);
    } finally {
      run.finishedAt = Date.now();
      ensureShownSource();
      render();
    }
  }, `Reopening ${sources[source].name}…`);
}

// Leave the view on a source that produced something rather than parking on a wall.
function ensureShownSource() {
  const visited = runSources.filter(source => sourceStates.has(source));
  const shown = visited.find(source => !WALL_KINDS.includes(sourceProgress.get(source)) && sourceProgress.get(source) === "done")
    || visited.find(source => !WALL_KINDS.includes(sourceProgress.get(source)))
    || visited.at(-1);
  if (shown && sourceStates.has(shown)) {
    activeSource = shown;
    state = sourceStates.get(shown);
  }
}

function render() {
  if (!state) return;
  renderSourceTabs();
  const configured = state.configuration?.typesafe;
  $("jev-status").textContent = !configured ? "Setup needed" : busy ? `Searching ${sources[backendSource]?.name || "sources"}` : run?.finishedAt ? "Shortlist ready to review" : "Jev ready";
  $("jev-pill").classList.toggle("warning", !configured);
  $("setup-warning").hidden = Boolean(configured);
  $("setup-message").textContent = configured ? "" : "Add TYPESAFE_API_KEY to .env, then restart.";
  $("start").querySelector("span").textContent = configured ? "Start searching" : "Setup required";
  $("status").textContent = currentAction;
  const page = state.page;
  $("empty").hidden = Boolean(page?.screenshot);
  $("screenshot").hidden = !page?.screenshot;
  if (page?.screenshot) {
    const frame = `data:image/jpeg;base64,${page.screenshot}`;
    if ($("screenshot").getAttribute("src") !== frame) $("screenshot").src = frame;
  } else if ($("screenshot").getAttribute("src")) {
    // Never leave another source's frame on screen once this one has none.
    $("screenshot").removeAttribute("src");
  }
  $("targets").hidden = !page?.screenshot || !$("overlays").checked;
  const decision = state.decision || state.decisions?.at(-1);
  if (page) {
    $("url").textContent = page.url;
    $("page-title").textContent = page.title;
    $("action-count").textContent = `${state.elements?.length || 0} observed elements`;
    $("choice-title").textContent = state.history?.length ? describeAction(state.history.at(-1)) : "Observing the page";
    $("completion").textContent = decision?.operation || "OBSERVE";
    $("confidence").textContent = decision ? `${percent(decision.target_confidence ?? decision.confidence)} action confidence` : "";
    $("latency").textContent = decision ? `${duration(decision.latency_ms)} inference` : "—";
    $("operation-choices").innerHTML = Object.entries(decision?.operation_probabilities || {}).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, probability]) => `<span class="operation-choice">${escape(name)} <b>${percent(probability)}</b></span>`).join("");
    if (page.actions?.length) {
      renderTargets(page, decision);
      renderTechnicalState(page, decision);
    }
  } else if (run) {
    // No page for this source: never leave the previous source's address on screen.
    $("url").textContent = "Opening the next source…";
  }
  renderReport();
  renderCompletion();
  renderMetrics();
  renderActivity();
  controls();
}

function applyRequestedFilters() {
  const parsed = parseSearchQuery($("goal").value);
  const applied = [];
  if (parsed.location) {
    $("location").value = parsed.location;
    applied.push(parsed.location);
  }
  if (parsed.homeType) {
    const radio = document.querySelector(`input[name="home-type"][value="${parsed.homeType}"]`);
    if (radio) {
      radio.checked = true;
      applied.push(radio.nextElementSibling?.textContent?.trim() || parsed.homeType);
    }
  }
  const rawMin = numericValue("min-price");
  const rawMax = numericValue("max-price");
  let minimum = rawMin ? Number(rawMin) : null;
  let maximum = rawMax ? Number(rawMax) : null;
  [minimum, maximum] = normalizeBudget(minimum, maximum, parsed);
  if (minimum != null) $("min-price").value = minimum.toLocaleString("en-US");
  if (maximum != null) $("max-price").value = maximum.toLocaleString("en-US");
  if (parsed.minPrice != null || parsed.maxPrice != null) {
    applied.push(`$${minimum?.toLocaleString("en-US") ?? "—"}–$${maximum?.toLocaleString("en-US") ?? "—"}`);
  }
  $("goal").value = parsed.preference;
  if (applied.length) setHint(`Applied from your request: ${applied.join(" · ")}`);
  return applied;
}

async function startSearch(event) {
  event?.preventDefault();
  if (busy) return;
  applyRequestedFilters();
  const settings = formSettings();
  if (!settings.location || !numericValue("max-price") || settings.maxPrice <= 0 || settings.minPrice > settings.maxPrice) {
    showError("Choose a city and a maximum rent above zero. The minimum cannot exceed the maximum.");
    return;
  }
  runSources = [...document.querySelectorAll('input[name="source"]:checked')].map(input => input.value);
  if (!runSources.length) {
    showError("Choose at least one rental marketplace.");
    return;
  }
  automatic = false;
  batchCancelled = false;
  sourceStates.clear();
  sourceProgress.clear();
  runEvents = [];
  run = { id: crypto.randomUUID(), startedAt: Date.now(), finishedAt: null, settings, firstMatchKey: null };
  state = { configuration: state?.configuration, page: null, status: "ready", history: [] };
  runSources.forEach(source => sourceProgress.set(source, "queued"));
  syncUrl(settings);
  rememberSearch();
  batchRunning = true;
  document.body.classList.remove("settings-open");
  $("edit-search").setAttribute("aria-expanded", "false");
  await perform(async () => {
    try {
      for (const source of runSources) {
        if (batchCancelled) break;
        // Only the backend moves to the new source here. `activeSource` follows once the
        // new page state actually arrives, so the tab label and address never get ahead
        // of the frame that is still on screen.
        backendSource = source;
        sourceProgress.set(source, "working");
        notice("Opening the marketplace", "notice", source);
        clearError();
        setActivity(`Opening ${sources[source].name}…`);
        render();
        try {
          await call("reset", { scenario: source, goal: buildGoal(source), text_values: buildTextValues() });
          if (batchCancelled) { sourceProgress.set(source, "stopped"); break; }
          await runAutomatically();
          if (!batchCancelled) await enrichCollected(source);
        } catch (error) {
          automatic = false;
          await recoverState();
          sourceProgress.set(source, "failed");
          notice(humanizeError(error.message), "error", source);
          showError(`${sources[source].name}: ${humanizeError(error.message)}`);
          saveRun();
          render();
          // A lost connection or expired token needs reconnection, never a mutation retry.
          if (!error.status || error.status === 403) break;
        }
      }
    } finally {
      automatic = false;
      batchRunning = false;
      run.finishedAt = Date.now();
      ensureShownSource();
      const partial = runSources.some(source => sourceProgress.get(source) !== "done");
      setActivity(batchCancelled ? "Stopped — your discoveries are saved" : partial ? "Partial search — review what we found" : "Browsing finished — your shortlist is ready");
      saveRun();
    }
  }, "Opening rental marketplaces…");
  render();
}

function updateSourceChrome() {
  const selected = document.querySelectorAll('input[name="source"]:checked').length;
  $("source-count").textContent = `${selected} selected`;
  $("scenario").value = selected > 1 ? "all" : document.querySelector('input[name="source"]:checked')?.value || "";
  if (!state?.page) {
    $("url").textContent = selected ? `Search across ${selected} rental marketplace${selected === 1 ? "" : "s"}` : "Choose a source";
  }
}

$("task-form").addEventListener("submit", startSearch);
$("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  $("task-form").requestSubmit();
});
document.querySelectorAll('input[name="source"]').forEach((input) => {
  input.addEventListener("change", updateSourceChrome);
});

$("choose").addEventListener("click", () =>
  perform(() => call("predict"), "Jev is comparing the actions…"),
);
$("execute").addEventListener("click", () =>
  perform(
    () => call("act", { fingerprint: state.page.fingerprint }),
    "Executing Jev's choice…",
  ),
);
$("auto").addEventListener("click", () =>
  perform(async () => {
    if (run) run.finishedAt = null;
    batchCancelled = false;
    sourceProgress.set(backendSource, "working");
    try { await runAutomatically(); }
    finally { if (run) run.finishedAt = Date.now(); saveRun(); }
  }, "Resuming the search…"),
);
$("stop").addEventListener("click", () => {
  batchCancelled = true;
  automatic = false;
  setActivity("Stopping after the current request…");
  controls();
});

$("source-tabs").addEventListener("click", (event) => {
  const source = event.target.closest("[data-source]")?.dataset.source;
  const saved = sourceStates.get(source);
  if (!saved?.page || busy) return;
  activeSource = source;
  state = saved;
  render();
});

$("overlays").addEventListener("change", () => {
  $("targets").hidden = !$("overlays").checked;
});

$("developer").addEventListener("change", () => {
  const on = $("developer").checked;
  document.body.classList.toggle("developer", on);
  saveDeveloperPreference(on);
  render();
});

$("completion-jump").addEventListener("click", () => {
  const target = run?.finishedAt && report?.qualified?.length ? "finale" : "report";
  $(target).scrollIntoView({ behavior: "smooth", block: "start" });
});

$("choices").addEventListener("pointerover", (event) => {
  const id = event.target.closest("[data-action]")?.dataset.action;
  document.querySelectorAll(".target").forEach((target) => {
    const selected = state?.decision?.target?.split(":")[0];
    target.classList.toggle("selected", target.dataset.action === id || target.dataset.action === selected);
  });
});

$("choices").addEventListener("pointerleave", () => {
  const selected = state?.decision?.target?.split(":")[0];
  document.querySelectorAll(".target").forEach((target) => {
    target.classList.toggle("selected", target.dataset.action === selected);
  });
});

for (const id of ["min-price", "max-price"]) {
  $(id).addEventListener("blur", () => {
    const value = numericValue(id);
    if (value) $(id).value = Number(value).toLocaleString("en-US");
  });
}

function setupVoiceSearch() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    $("voice").title = "Voice search is available in Google Chrome";
    $("voice").setAttribute("aria-label", "Voice search requires Google Chrome");
    $("voice").addEventListener("click", () => {
      setHint("Open Hearth in Google Chrome to use voice search.", true);
    });
    return;
  }

  const SILENCE_MS = 1800;
  recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.interimResults = true;
  // Keep one session open across pauses; a short hesitation must not end the request.
  recognition.continuous = true;

  let listening = false;
  let transcript = "";
  let silenceTimer = null;
  let restarts = 0;

  const stopSilenceTimer = () => {
    if (silenceTimer) window.clearTimeout(silenceTimer);
    silenceTimer = null;
  };
  const setIdle = () => {
    listening = false;
    stopSilenceTimer();
    $("voice").classList.remove("listening");
    $("voice").setAttribute("aria-label", "Search by voice");
  };
  const finish = () => {
    if (!listening) return;
    listening = false;
    stopSilenceTimer();
    const heard = Boolean(transcript.trim());
    submitAfterVoice = heard;
    // Write this before stop(): the end handler submits and may replace it with "Applied from…".
    setHint(heard ? "Got it — starting your search." : "I didn't catch that. Try again.");
    try {
      recognition.stop();
    } catch {
      // Already stopped; the end handler still runs.
    }
  };
  const waitForSilence = () => {
    stopSilenceTimer();
    silenceTimer = window.setTimeout(finish, SILENCE_MS);
  };

  recognition.addEventListener("start", () => {
    listening = true;
    transcript = "";
    submitAfterVoice = false;
    $("voice").classList.add("listening");
    $("voice").setAttribute("aria-label", "Stop listening and search");
    // The button's own listening state is the cue; no standing instruction line.
    setHint("");
  });
  recognition.addEventListener("result", (event) => {
    transcript = [...event.results].map((result) => result[0].transcript).join(" ").trim();
    $("goal").value = transcript;
    restarts = 0;
    // Only a real pause submits, so a pause mid-sentence no longer cuts the request short.
    waitForSilence();
  });
  recognition.addEventListener("error", (event) => {
    if (event.error === "aborted" && !listening) return; // Our own stop(); the end handler submits.
    if (event.error === "no-speech" && listening) return; // Silence is handled by the timer/end path.
    listening = false;
    setIdle();
    submitAfterVoice = false;
    setHint(event.error === "not-allowed" ? "Microphone access was not allowed." : "I couldn't hear that. Try again.");
  });
  recognition.addEventListener("end", () => {
    if (listening) {
      // Chrome can close the session on its own; reopen it so the request keeps listening.
      if (restarts >= 5) {
        setIdle();
        setHint("Voice search stopped. Tap Speak to try again.");
        return;
      }
      restarts += 1;
      try {
        recognition.start();
      } catch {
        setIdle();
      }
      return;
    }
    setIdle();
    if (submitAfterVoice && !busy) {
      submitAfterVoice = false;
      $("task-form").requestSubmit();
    }
  });
  $("voice").addEventListener("click", () => {
    if (listening) {
      finish();
      return;
    }
    restarts = 0;
    try {
      recognition.start();
    } catch {
      setHint("Voice search is already starting.");
    }
  });
}

$("download").addEventListener("click", () => {
  const states = [...sourceStates].map(([source, data]) => ({
    source, status: sourceProgress.get(source), history: data.history, decisions: (data.decisions || []).map(({ request, raw_answers, ...item }) => item),
    text_calls: data.text_calls, url: data.page?.url,
  }));
  const blob = new Blob([JSON.stringify({ run, sources: states, totals: summarizeTelemetry(sourceStates) }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "hearth-search-receipt.json";
  link.click();
  URL.revokeObjectURL(url);
});

$("edit-search").addEventListener("click", () => {
  const open = document.body.classList.toggle("settings-open");
  $("edit-search").setAttribute("aria-expanded", String(open));
  if (open) $("location").focus();
});
$("new-search").addEventListener("click", startSearch);
$("retry-source").addEventListener("click", () => retrySource(activeSource));
for (const mode of ["activity", "filtering"]) {
  $(`tab-${mode}`).addEventListener("click", () => {
    for (const name of ["activity", "filtering"]) {
      $(`tab-${name}`).classList.toggle("selected", name === mode);
      $(`tab-${name}`).setAttribute("aria-pressed", String(name === mode));
    }
    $("history").hidden = mode !== "activity";
    $("filter-history").hidden = mode !== "filtering";
  });
}
// Failed listing images get an honest fallback, not a broken image icon.
document.addEventListener("error", event => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || !image.closest(".listing-photo")) return;
  image.parentElement.classList.add("placeholder");
  image.insertAdjacentHTML("afterend", '<span class="photo-fallback">⌂<small>Photo unavailable</small></span>');
  image.remove();
}, true);

async function initialize() {
  const params = new URLSearchParams(location.search);
  const requestedId = params.get("s");
  try {
    if (!params.size) {
      // A bare home page is a clean slate: no restored run, no stale banner, empty request.
      sessionStorage.removeItem(SESSION_KEY);
      $("goal").value = "";
    } else {
      const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
      const matchesRequested = saved?.run && (!requestedId || saved.run.id === requestedId);
      if (matchesRequested && saved.sources?.every(source => sources[source])) {
        run = saved.run;
        runEvents = saved.events || [];
        runSources = saved.sources;
        for (const [source, data] of saved.states || []) sourceStates.set(source, data);
        for (const [source, progress] of saved.progress || []) sourceProgress.set(source, progress);
        activeSource = saved.activeSource;
        if (!run.finishedAt) {
          run.finishedAt = run.savedAt || Date.now();
          for (const [source, progress] of sourceProgress) if (progress === "working") sourceProgress.set(source, "stopped");
          notice("Page reloaded. Partial results restored; no actions were replayed.", "notice");
        }
        const settings = run.settings;
        $("location").value = settings.location;
        $("min-price").value = settings.minPrice.toLocaleString("en-US");
        $("max-price").value = settings.maxPrice.toLocaleString("en-US");
        $("date-listed").value = String(settings.daysListed);
        const type = document.querySelector(`input[name="home-type"][value="${settings.requestedType}"]`);
        if (type) type.checked = true;
        for (const input of document.querySelectorAll('input[name="source"]')) input.checked = runSources.includes(input.value);
        $("goal").value = settings.preference || "";
        state = sourceStates.get(activeSource) || [...sourceStates.values()].at(-1);
        setActivity("Previous search restored — review your shortlist");
      } else {
        sessionStorage.removeItem(SESSION_KEY);
      }
    }
  } catch { sessionStorage.removeItem(SESSION_KEY); }
  try {
    const response = await fetch("/api/state", { signal: AbortSignal.timeout(7000) });
    if (!response.ok) throw Error("The local service is unavailable.");
    const initial = await response.json();
    if (initial.pricing) pricing = initial.pricing;
    const matching = [...sourceStates].find(([, data]) => data.run_id && data.run_id === initial.run_id);
    if (matching) {
      backendSource = matching[0];
      acceptState(backendSource, initial);
    } else if (!state) state = { configuration: initial.configuration, page: null, status: "idle", history: [] };
    else state.configuration = initial.configuration;
    window.hearthReady = true;
  } catch {
    state ||= { configuration: {}, page: null, history: [], status: "idle" };
    state.configuration = {};
    showError("Cannot reach the local service. Saved results are retained. Restart the server and refresh to reconnect.");
  }
  applyUrlSettings();
  updateSourceChrome();
  render();
  // ?go=1 starts the URL-configured search immediately, for a scripted demo.
  if (params.get("go") === "1" && !run && state?.configuration?.typesafe) {
    window.setTimeout(() => {
      if (!busy) $("task-form").requestSubmit();
    }, 600);
  }
}

// Restore the Developer toggle before the first paint so dev-only controls never flash.
function setupDeveloperToggle() {
  const on = readDeveloperPreference();
  $("developer").checked = on;
  document.body.classList.toggle("developer", on);
}

setupDeveloperToggle();
setupVoiceSearch();
window.setInterval(renderClock, 250);
initialize();
