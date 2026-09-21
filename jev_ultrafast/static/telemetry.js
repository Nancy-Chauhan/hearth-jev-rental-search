// Presentation-only telemetry. It never chooses or executes browser actions.
const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function reportedCost(usage) {
  // Only explicitly denominated USD fields; generic credits/tokens are not dollars.
  for (const key of ["cost_usd", "costUsd"]) {
    if (finite(usage?.[key])) return usage[key];
  }
  return null;
}

// Providers usually report tokens, not dollars. Read both naming conventions.
export function tokenUsage(usage) {
  const read = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);
  return {
    input: read(usage?.input_tokens ?? usage?.prompt_tokens),
    output: read(usage?.output_tokens ?? usage?.completion_tokens),
  };
}

const rate = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

// An estimate only exists when the operator supplied a rate. Hearth never invents
// one. Two shapes are supported: a flat per-billion rate over all tokens, or a
// per-million split for input and output.
export function estimateCost(tokens, pricing) {
  const input = tokens?.input || 0;
  const output = tokens?.output || 0;
  if (!input && !output) return null;
  const inputRate = rate(pricing?.input_per_mtok);
  const outputRate = rate(pricing?.output_per_mtok);
  if (inputRate !== null && outputRate !== null) {
    return (input / 1e6) * inputRate + (output / 1e6) * outputRate;
  }
  const flatRate = rate(pricing?.per_btok);
  if (flatRate !== null) return ((input + output) / 1e9) * flatRate;
  return null;
}

export function describeRate(pricing) {
  const inputRate = rate(pricing?.input_per_mtok);
  const outputRate = rate(pricing?.output_per_mtok);
  if (inputRate !== null && outputRate !== null) return `$${inputRate}/$${outputRate} per 1M tokens`;
  const flatRate = rate(pricing?.per_btok);
  return flatRate === null ? "" : `$${flatRate} per 1B tokens`;
}

export function compactTokens(count) {
  if (!finite(count) || count <= 0) return "0";
  if (count < 1000) return String(Math.round(count));
  if (count < 1e6) return `${(count / 1000).toFixed(count < 1e4 ? 1 : 0)}K`;
  return `${(count / 1e6).toFixed(1)}M`;
}

export function dollars(value) {
  if (!finite(value)) return "—";
  if (value > 0 && value < 0.0001) return "<$0.0001";
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

export function duration(value) {
  if (!finite(value)) return "—";
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
}

export function actionCost(item) {
  const decision = reportedCost(item.usage);
  if (decision == null) return null;
  if (item.text_source !== "generated") return decision;
  const helper = reportedCost(item.text_usage);
  return helper == null ? null : decision + helper;
}

export function summarizeTelemetry(groups) {
  const calls = new Map();
  const actions = new Map();
  const pages = new Set();
  for (const [source, state] of groups) {
    const prefix = `${source}:${state.run_id || "legacy"}`;
    (state.decisions || []).forEach((call, i) => calls.set(`${prefix}:decision:${call.call_id || i}`, call));
    (state.text_calls || []).forEach((call, i) => {
      if (!call.model?.includes("supplied value")) calls.set(`${prefix}:text:${call.call_id || i}`, call);
    });
    for (const item of state.history || []) {
      actions.set(`${prefix}:${item.step}`, item);
      if (item.url) pages.add(item.url);
    }
    for (const url of state.visited_pages || []) pages.add(url);
    if (state.page?.url) pages.add(state.page.url);
  }
  const costs = [...calls.values()].map(call => reportedCost(call.usage));
  const known = costs.filter(value => value != null);
  const tokens = { input: 0, output: 0 };
  for (const call of calls.values()) {
    const usage = tokenUsage(call.usage);
    tokens.input += usage.input;
    tokens.output += usage.output;
  }
  return {
    actions: actions.size,
    clicks: [...actions.values()].filter(item => item.kind === "click").length,
    pages: pages.size,
    calls: calls.size,
    knownCalls: known.length,
    cost: known.length ? known.reduce((sum, value) => sum + value, 0) : null,
    costComplete: calls.size > 0 && known.length === calls.size,
    tokens,
  };
}

// Internal failures read as noise to a user; say what happened and what to do.
const ERROR_HINTS = [
  [/session with given id not found|no target with given id|-32001|no session with given id/i,
    "The browser tab Hearth was using was closed or discarded. Start the search again to reopen it."],
  [/no close frame|websocket|1006|connection closed|target closed|session closed/i,
    "Lost the connection to Chrome. Reconnect the browser, then run the search again."],
  [/TYPESAFE_API_KEY/i, "Add TYPESAFE_API_KEY to .env, then restart Hearth."],
  [/Model connection failed|Model unavailable/i, "Could not reach the model service; no action was executed."],
  [/HTTP (\d{3})/i, "The model service returned HTTP $1."],
  [/model-call budget|action budget|demo budget/i, "Stopped at the demo's step limit for this source."],
  [/Dropdown execution was (?:interrupted|not confirmed)/i, "A dropdown could not be confirmed, so it was left unchanged."],
  [/no supplied value/i, "Nothing in your request belonged in that field, so it was left empty."],
  [/Cannot reach the local service/i, "Cannot reach the local service. Restart the server, then refresh."],
];

// A CDP failure arrives as a Python dict repr; pull the human sentence out of it.
function unwrapProviderError(text) {
  const match = /'message':\s*'([^']+)'/.exec(text) || /"message":\s*"([^"]+)"/.exec(text);
  return match ? match[1] : text;
}

export function humanizeError(message) {
  const raw = String(message ?? "").replace(/\s+/g, " ").trim();
  const text = unwrapProviderError(raw);
  if (!text) return "This source stopped without reporting a reason.";
  for (const [pattern, replacement] of ERROR_HINTS) {
    const match = pattern.exec(text) || pattern.exec(raw);
    if (match) return replacement.replace(/\$(\d)/g, (_, index) => match[Number(index)] ?? "");
  }
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

// A page that is standing between the agent and the results. Matched on continuity phrasing, not
// on the mere presence of a "Sign in" button, which every marketplace has.
const PAGE_BLOCKS = [
  [/human verification|verify (?:you are|that you are) human|are you a robot|unusual traffic|security check|captcha|checking your browser|press & hold|just a moment/i,
    { kind: "challenge", label: "bot check" }],
  [/session (?:has )?(?:expired|timed out)|(?:please )?sign in to continue|log in to continue|you must (?:sign|log) in|create an account to continue/i,
    { kind: "signin", label: "sign-in wall" }],
  [/rate limit|too many requests|temporarily blocked|request blocked|access denied|slow down/i,
    { kind: "ratelimit", label: "rate limit" }],
];

export function classifyPage(page) {
  if (!page) return null;
  const haystack = `${page.title || ""}\n${page.text || ""}`.slice(0, 4000);
  for (const [pattern, result] of PAGE_BLOCKS) if (pattern.test(haystack)) return { ...result };
  return null;
}

export function summarizeReasons(reasons) {
  const counts = new Map();
  for (const reason of reasons || []) counts.set(reason, (counts.get(reason) || 0) + 1);
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
}

// "0 matches" is honest but useless on its own; say what filtered everything out.
export function describeExclusions(reasons) {
  const top = summarizeReasons(reasons).slice(0, 2);
  if (!top.length) return "";
  const parts = top.map(({ reason, count }) => `${count} ${reason.toLowerCase()}`);
  return `Nothing here passed your filters — ${parts.join(", ")}.`;
}

const CHECK_LABELS = { price: "price", location: "city", home: "home type", recency: "listing date" };

// Candidates that were kept but did not qualify each say which check held them back.
export function describePending(pending) {
  const items = pending || [];
  if (!items.length) return "";
  const tally = new Map();
  for (const item of items) {
    for (const [key, value] of Object.entries(item.checks || {})) {
      if (value !== "pass") tally.set(key, (tally.get(key) || 0) + 1);
    }
  }
  const head = `${items.length} candidate${items.length === 1 ? "" : "s"} here, none passed all four checks`;
  const parts = [...tally.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 2)
    .map(([key, count]) => `${CHECK_LABELS[key] || key} unconfirmed on ${count}`);
  return parts.length ? `${head} — ${parts.join(", ")}.` : `${head}.`;
}

// Why a source ended. "blocked" alone conflates several different situations, so say which one.
export function describeStop(progress, { budgetSpent = false, maxTurns = 0, blocked = null, excluded = null, pending = null } = {}) {
  if (progress === "done") return "Finished browsing this source; listing checks are separate.";
  if (progress === "stopped") return "Stopped on request; the page was left as it was.";
  if (blocked) return `This source showed a ${blocked.label} and was left alone; try it again later.`;
  const filtered = excluded?.length ? describeExclusions(excluded) : "";
  if (filtered) return filtered;
  const unconfirmed = pending?.length ? describePending(pending) : "";
  if (unconfirmed) return unconfirmed;
  if (budgetSpent) return `Ran out of steps (${maxTurns}) before finishing — some results may be missing.`;
  return "This source stopped early — nothing else on the page could advance the search.";
}

export function cleanLabel(label = "") {
  let text = String(label).replace(/(?:\s+Control near\b.*)$/i, "").replace(/^Control near\s+/i, "")
    .replace(/\s+/g, " ").trim();
  // Accessible names sometimes repeat themselves; "Filters · 2 Filters · 2" is just noise.
  const repeated = /^(.+?)(?:\s*\1)+$/.exec(text);
  if (repeated) text = repeated[1];
  const parts = text.split(" · ");
  text = parts.filter((part, index) => part && part !== parts[index - 1]).join(" · ");
  return text.slice(0, 100) || "page control";
}

export function describeAction(item, pending = false) {
  const label = cleanLabel(item.action || item.label);
  const kind = item.kind || ({ TYPE_TEXT: "fill", CLICK: "click", SELECT: "select", WAIT: "wait" })[item.operation];
  if (kind === "fill") {
    const field = /max(?:imum)?/i.test(label) ? "maximum rent" : /min(?:imum)?/i.test(label) ? "minimum rent" : label;
    return `${pending ? "Setting" : "Set"} ${field}${item.text != null ? ` to “${item.text}”` : ""}`;
  }
  if (kind === "scroll") return `${pending ? "Scrolling" : "Scrolled"} ${/up/i.test(label) ? "up" : "down"} to inspect the page`;
  if (kind === "wait") return pending ? "Waiting for the page to update" : "Waited for the page to update";
  if (kind === "select") return `${pending ? "Selecting" : "Selected"} ${label}`;
  return `${pending ? "Opening" : "Opened"} ${label.replace(/^Open\s+/i, "")}`;
}

export function normalizeBudget(minimum, maximum, parsed) {
  if (parsed.minPrice != null && parsed.maxPrice != null) {
    return [Math.min(parsed.minPrice, parsed.maxPrice), Math.max(parsed.minPrice, parsed.maxPrice)];
  }
  // A maximum-only natural-language request replaces the previous range.
  if (parsed.maxPrice != null) return [0, parsed.maxPrice];
  if (parsed.minPrice != null) return [parsed.minPrice, Math.max(maximum || 0, parsed.minPrice)];
  return [minimum, maximum];
}
