// Deterministic contracts for presentation-only telemetry helpers.
// Run with: node --test tests/telemetry.test.js

import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyPage, cleanLabel, compactTokens, describeAction, describeExclusions, describePending, describeRate, describeStop, summarizeReasons, dollars, duration, estimateCost, humanizeError, normalizeBudget, summarizeTelemetry, tokenUsage } from "../jev_ultrafast/static/telemetry.js";

test("internal failures are translated into something a user can act on", () => {
  assert.match(humanizeError("no close frame received or sent"), /Lost the connection to Chrome/);
  assert.match(humanizeError("WebSocket is already in CLOSING or CLOSED state"), /Lost the connection to Chrome/);
  assert.match(humanizeError("TYPESAFE_API_KEY is missing; add it to .env and restart Hearth."), /TYPESAFE_API_KEY/);
  assert.match(humanizeError("Model provider returned HTTP 529; no action executed."), /returned HTTP 529/);
  assert.match(humanizeError("Reached the demo's model-call budget"), /step limit/);
  assert.match(humanizeError("Dropdown execution was not confirmed; inspect before retrying."), /left unchanged/);
  assert.match(humanizeError("Jev found no supplied value for the selected text field"), /left empty/);
});

test("an unknown error keeps its own words instead of inventing a reason", () => {
  assert.equal(humanizeError("Something entirely new happened"), "Something entirely new happened");
  const long = "x".repeat(400);
  assert.equal(humanizeError(long).length, 158); // 157 characters plus the ellipsis
  assert.ok(humanizeError(long).endsWith("…"));
  assert.match(humanizeError(""), /without reporting a reason/);
  assert.match(humanizeError(undefined), /without reporting a reason/);
});

test("cleanLabel removes noise without mangling a real label", () => {
  assert.equal(cleanLabel("Filters · 2 Filters · 2"), "Filters · 2");
  assert.equal(cleanLabel("A · B · B · C"), "A · B · C");
  assert.equal(cleanLabel("Control near Search"), "Search");
  assert.equal(cleanLabel("Maximum price"), "Maximum price");
  assert.equal(cleanLabel(""), "page control");
});

test("actions are described in plain language", () => {
  assert.equal(describeAction({ kind: "fill", action: "Maximum price", text: "2000" }), "Set maximum rent to “2000”");
  assert.equal(describeAction({ kind: "wait", action: "Wait" }), "Waited for the page to update");
  assert.equal(describeAction({ kind: "click", action: "Open Filters · 2" }), "Opened Filters · 2");
  assert.equal(describeAction({ kind: "click", action: "Filters · 2" }, true), "Opening Filters · 2");
});

test("costs and durations never pretend to be zero", () => {
  assert.equal(dollars(null), "—");
  assert.equal(dollars(undefined), "—");
  assert.equal(dollars(0.00002), "<$0.0001");
  assert.equal(dollars(0.25), "$0.2500");
  assert.equal(dollars(2), "$2.00");
  assert.equal(duration(null), "—");
  assert.equal(duration(142), "142 ms");
  assert.equal(duration(1500), "1.50 s");
});

test("a maximum-only request clears the previous minimum", () => {
  assert.deepEqual(normalizeBudget(2000, 4000, { minPrice: null, maxPrice: 2500 }), [0, 2500]);
  assert.deepEqual(normalizeBudget(2000, 4000, { minPrice: 1500, maxPrice: 2500 }), [1500, 2500]);
  assert.deepEqual(normalizeBudget(2000, 4000, { minPrice: 3000, maxPrice: null }), [3000, 4000]);
});

test("a raw CDP error dict never reaches the user", () => {
  const raw = "{'code': -32001, 'message': 'Session with given id not found.'}";
  const message = humanizeError(raw);
  assert.match(message, /browser tab Hearth was using/);
  assert.doesNotMatch(message, /-32001|'message'/);
  assert.match(humanizeError('{"code": -32001, "message": "Session with given id not found."}'),
    /browser tab Hearth was using/);
});

test("candidates that were kept but unconfirmed say which check held them back", () => {
  const pending = [
    { checks: { price: "pass", location: "unknown", home: "pass", recency: "pass" } },
    { checks: { price: "pass", location: "unknown", home: "pass", recency: "pass" } },
    { checks: { price: "pass", location: "pass", home: "unknown", recency: "pass" } },
  ];
  assert.equal(describePending(pending),
    "3 candidates here, none passed all four checks — city unconfirmed on 2, home type unconfirmed on 1.");
  assert.equal(describePending([{ checks: { price: "pass", location: "pass", home: "pass", recency: "pass" } }]),
    "1 candidate here, none passed all four checks.");
  assert.equal(describePending([]), "");
  // It explains a "0 matches" source, but a wall or an all-excluded source still outranks it.
  const message = describeStop("blocked", { budgetSpent: true, maxTurns: 40, pending });
  assert.match(message, /city unconfirmed on 2/);
  assert.doesNotMatch(message, /Ran out of steps/);
  assert.match(describeStop("blocked", { blocked: { label: "bot check" }, pending }), /bot check/);
  assert.match(describeStop("blocked", { excluded: ["Outside your budget"], pending }), /passed your filters/);
});

test("an all-excluded source explains what filtered it out", () => {
  const reasons = ["Outside your budget", "Outside your budget", "Different home type"];
  assert.deepEqual(summarizeReasons(reasons), [
    { reason: "Outside your budget", count: 2 },
    { reason: "Different home type", count: 1 },
  ]);
  assert.equal(describeExclusions(reasons),
    "Nothing here passed your filters — 2 outside your budget, 1 different home type.");
  assert.equal(describeExclusions([]), "");
  // The explanation outranks the generic "stopped early" and the step-budget wording.
  const message = describeStop("blocked", { budgetSpent: true, maxTurns: 40, excluded: reasons });
  assert.match(message, /Nothing here passed your filters/);
  assert.doesNotMatch(message, /Ran out of steps/);
  // A wall still outranks it: nothing was collected to filter.
  assert.match(describeStop("blocked", { blocked: { label: "bot check" }, excluded: reasons }), /bot check/);
});

test("a wall between the agent and the results is named for what it is", () => {
  // The exact string Redfin returned in a live four-source run.
  assert.deepEqual(classifyPage({ title: "Human Verification" }), { kind: "challenge", label: "bot check" });
  assert.equal(classifyPage({ text: "Please verify you are human to continue" }).kind, "challenge");
  assert.equal(classifyPage({ text: "Your session has expired. Sign in to continue." }).kind, "signin");
  assert.equal(classifyPage({ text: "Too many requests — rate limit exceeded" }).kind, "ratelimit");
  // A normal marketplace page offering a sign-in button is not a wall.
  assert.equal(classifyPage({ title: "Marketplace", text: "Sign In Join Facebook Log In" }), null);
  assert.equal(classifyPage({ title: "Zillow", text: "Save Search Sign In" }), null);
  assert.equal(classifyPage(null), null);
});

test("a wall is reported ahead of the generic partial message", () => {
  const blocked = { kind: "challenge", label: "bot check" };
  assert.match(describeStop("blocked", { blocked }), /showed a bot check/);
  assert.doesNotMatch(describeStop("blocked", { blocked }), /nothing else on the page/);
  // A finished source is still reported as finished, wall or not.
  assert.match(describeStop("done", { blocked }), /Finished browsing this source/);
});

test("why a source ended is stated, not merged into one vague sentence", () => {
  assert.match(describeStop("done"), /Finished browsing this source/);
  assert.match(describeStop("stopped"), /Stopped on request/);
  assert.match(describeStop("blocked", { budgetSpent: true, maxTurns: 40 }), /Ran out of steps \(40\)/);
  assert.match(describeStop("blocked", { budgetSpent: false }), /stopped early/);
  // The two "blocked" cases must not read the same.
  assert.notEqual(
    describeStop("blocked", { budgetSpent: true, maxTurns: 40 }),
    describeStop("blocked", { budgetSpent: false }),
  );
});

test("token usage is read from either provider naming convention", () => {
  assert.deepEqual(tokenUsage({ input_tokens: 8179, output_tokens: 560 }), { input: 8179, output: 560 });
  assert.deepEqual(tokenUsage({ prompt_tokens: 400, completion_tokens: 40 }), { input: 400, output: 40 });
  assert.deepEqual(tokenUsage(undefined), { input: 0, output: 0 });
  assert.deepEqual(tokenUsage({ input_tokens: -5, output_tokens: "x" }), { input: 0, output: 0 });
});

test("token totals are summed across decisions and text calls", () => {
  const groups = new Map([["craigslist", {
    run_id: "r1",
    decisions: [{ call_id: "c1", usage: { input_tokens: 1000, output_tokens: 100 } }],
    text_calls: [{ call_id: "t1", model: "deepseek-chat", usage: { prompt_tokens: 400, completion_tokens: 40 } }],
    history: [{ step: 1, kind: "click", url: "https://example.test/" }],
  }]]);
  const stats = summarizeTelemetry(groups);
  assert.deepEqual(stats.tokens, { input: 1400, output: 140 });
  assert.equal(stats.calls, 2);
  assert.equal(stats.cost, null); // Tokens are not dollars.
  assert.equal(stats.costComplete, false);
});

test("an estimate needs operator-configured rates", () => {
  const tokens = { input: 1_000_000, output: 500_000 };
  assert.equal(estimateCost(tokens, undefined), null);
  assert.equal(estimateCost(tokens, { input_per_mtok: null, output_per_mtok: null }), null);
  assert.equal(estimateCost({ input: 0, output: 0 }, { input_per_mtok: 3, output_per_mtok: 15 }), null);
  assert.equal(estimateCost(tokens, { input_per_mtok: 3, output_per_mtok: 15 }), 3 + 7.5);
  assert.equal(estimateCost(tokens, { input_per_mtok: -1, output_per_mtok: 15 }), null);
});

test("a flat per-billion rate covers all tokens", () => {
  const pricing = { per_btok: 42 };
  assert.equal(estimateCost({ input: 0, output: 0 }, pricing), null);
  assert.equal(estimateCost({ input: 1_000_000_000, output: 0 }, pricing), 42);
  assert.equal(estimateCost({ input: 250_000_000, output: 250_000_000 }, pricing), 21);
  // 266K tokens at $42/1B is a fraction of a cent, not zero.
  const tiny = estimateCost({ input: 200_000, output: 66_000 }, pricing);
  assert.ok(tiny > 0 && tiny < 0.02, `expected a small positive cost, got ${tiny}`);
  assert.equal(Math.round(tiny * 1e5) / 1e5, 0.01117);
});

test("split per-million rates win over a flat rate", () => {
  const tokens = { input: 1_000_000, output: 1_000_000 };
  assert.equal(estimateCost(tokens, { per_btok: 42, input_per_mtok: 3, output_per_mtok: 15 }), 18);
});

test("the rate used is described so the number is never ambiguous", () => {
  assert.equal(describeRate({ per_btok: 42 }), "$42 per 1B tokens");
  assert.equal(describeRate({ input_per_mtok: 3, output_per_mtok: 15 }), "$3/$15 per 1M tokens");
  assert.equal(describeRate({ per_btok: null }), "");
  assert.equal(describeRate(undefined), "");
});

test("token counts stay readable at every scale", () => {
  assert.equal(compactTokens(0), "0");
  assert.equal(compactTokens(842), "842");
  assert.equal(compactTokens(8179), "8.2K");
  assert.equal(compactTokens(48300), "48K");
  assert.equal(compactTokens(2_400_000), "2.4M");
  assert.equal(compactTokens(null), "0");
});
