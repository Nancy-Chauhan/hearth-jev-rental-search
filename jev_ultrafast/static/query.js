// Pure, DOM-free parsing of a natural-language rental request into sidebar filters.
// Shared by the Hearth UI and the Node tests. Kept JS-only so `node --test` can import it.

const SMALL = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const NUMBER_WORDS = [...Object.keys(SMALL), ...Object.keys(TENS), "hundred", "thousand"];
const WORD_LIST = NUMBER_WORDS.join("|");
const NUMBER_RUN = new RegExp(String.raw`\b(?:${WORD_LIST})(?:[\s-]+(?:${WORD_LIST}))*\b`, "gi");

// A money amount: an explicit "$", a "k" suffix, or a bare 3+ digit number.
const AMT = String.raw`(?:\$\s*\d[\d,]*(?:\.\d+)?\s*[kK]?|\d[\d,]*(?:\.\d+)?\s*[kK]\b|\d[\d,]{2,})`;
const UPPER_RE = new RegExp(
  String.raw`\b(?:(?<!no )less than|up to|no more than|at most|cheaper than|maximum|max(?:imum)?(?:\s+of)?|under|below|within)\s+(${AMT})`,
  "i",
);
const LOWER_RE = new RegExp(
  String.raw`\b(?:(?<!no )more than|at least|starting at|upwards of|minimum|min(?:imum)?(?:\s+of)?|over|above|from)\s+(${AMT})`,
  "i",
);
const BUDGET_HINT =
  /\b(?:rent|rents|budget|month|monthly|price|prices|pay|cost|under|below|over|above|about|around|max|min|maximum|minimum|between|from|to|per|up|no more than)\b/i;
const RANGE_JOIN = new Set(["to", "and", "-", "–", "—", "through", "thru"]);
const UNIT_AFTER = /^\s*(?:sq\.?\s?ft|sqft|square|sq\b|bd\b|bed|bath|ba\b|br\b|mi\b|mile|min\b|minute|hour|%|st\b|nd\b|rd\b|th\b)/i;

const TYPE_PATTERNS = [
  [/\bstudios?\b/i, "studio"],
  [/\b(?:apartments?|flats?|condos?|condominiums?|lofts?)\b/i, "flat"],
  [/\b(?:houses?|townhouses?|townhomes?|single[- ]family)\b/i, "house"],
];

const LOC_RE = /\b(?:in|near)\s+([A-Z][\w.'-]*(?:\s+[A-Za-z][\w.'-]*){0,3})/;
const LOC_BREAK = new Set([
  "for", "under", "over", "below", "above", "with", "and", "or", "that", "near", "around",
  "between", "max", "min", "maximum", "minimum", "budget", "price", "rent", "to", "from",
  "at", "on", "per", "a", "an", "the", "in", "is", "are", "of",
]);
const LOC_NON_PLACE = new Set([
  "bart", "parking", "transit", "gym", "laundry", "pets", "garage", "yard", "balcony",
  "furnished", "modern", "quiet", "walkable", "sunlight", "light",
]);

const EMPTY = { location: null, minPrice: null, maxPrice: null, homeType: null, preference: "" };

function wordsToNumber(phrase) {
  let total = 0;
  let current = 0;
  for (const token of phrase.toLowerCase().split(/[\s-]+/).filter(Boolean)) {
    if (token in SMALL) current += SMALL[token];
    else if (token in TENS) current += TENS[token];
    else if (token === "hundred") current = (current || 1) * 100;
    else if (token === "thousand") {
      total += (current || 1) * 1000;
      current = 0;
    }
  }
  return total + current;
}

// Spoken numbers arrive as words ("twenty five hundred") or digits ("2.5k"); normalize to digits.
function normalizeNumberWords(text) {
  return text.replace(NUMBER_RUN, (phrase) => String(wordsToNumber(phrase)));
}

function parseAmountToken(token) {
  const thousands = /[kK]\s*$/.test(token);
  const digits = (token.match(/[\d,]+(?:\.\d+)?/) || [""])[0].replaceAll(",", "");
  const value = Number(digits) * (thousands ? 1000 : 1);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function isMoney(text, start, token) {
  if (token.includes("$") || /[kK]\s*$/.test(token)) return true;
  const after = text.slice(start + token.length, start + token.length + 8);
  if (UNIT_AFTER.test(after)) return false;
  return BUDGET_HINT.test(text.slice(Math.max(0, start - 24), start + token.length + 14));
}

function findAmounts(text, strict) {
  const re = new RegExp(AMT, "gi");
  const found = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    if (!match[0]) {
      re.lastIndex += 1;
      continue;
    }
    if (strict && !isMoney(text, match.index, match[0])) continue;
    const value = parseAmountToken(match[0]);
    if (value !== null) found.push({ value, start: match.index, end: match.index + match[0].length, token: match[0] });
  }
  return found;
}

function budgetFrom(text) {
  const amounts = findAmounts(text, false);
  for (let index = 0; index + 1 < amounts.length; index += 1) {
    const [low, high] = [amounts[index], amounts[index + 1]];
    const join = text.slice(low.end, high.start).trim().toLowerCase();
    if (!RANGE_JOIN.has(join)) continue;
    const lead = /(?:between|from)\s+$/i.exec(text.slice(Math.max(0, low.start - 10), low.start));
    const start = lead ? low.start - lead[0].length : low.start;
    return {
      minPrice: Math.min(low.value, high.value),
      maxPrice: Math.max(low.value, high.value),
      phrases: [text.slice(start, high.end)],
    };
  }
  const upper = UPPER_RE.exec(text);
  const lower = LOWER_RE.exec(text);
  if (upper || lower) {
    const result = { phrases: [] };
    if (upper) {
      result.maxPrice = parseAmountToken(upper[1]);
      result.phrases.push(upper[0]);
    }
    if (lower) {
      result.minPrice = parseAmountToken(lower[1]);
      result.phrases.push(lower[0]);
    }
    if (result.minPrice != null && result.maxPrice != null && result.minPrice > result.maxPrice) {
      [result.minPrice, result.maxPrice] = [result.maxPrice, result.minPrice];
    }
    return result;
  }
  const hinted = findAmounts(text, true);
  return hinted.length ? { maxPrice: hinted[0].value, phrases: [hinted[0].token] } : { phrases: [] };
}

function homeTypeFrom(text) {
  const hits = TYPE_PATTERNS.map(([pattern, type]) => {
    const match = pattern.exec(text);
    return match ? { type, phrase: match[0] } : null;
  }).filter(Boolean);
  const types = [...new Set(hits.map((hit) => hit.type))];
  if (types.length !== 1) return { phrases: [] };
  return { homeType: types[0], phrases: [hits[0].phrase] };
}

function locationFrom(text) {
  const match = LOC_RE.exec(text);
  if (!match) return { phrases: [] };
  const tokens = [];
  for (const word of match[1].split(/\s+/)) {
    if (LOC_BREAK.has(word.toLowerCase())) break;
    tokens.push(word);
  }
  const place = tokens.join(" ").replace(/[.,;:]+$/, "").trim();
  if (!place) return { phrases: [] };
  if (tokens.length === 1 && LOC_NON_PLACE.has(place.toLowerCase())) return { phrases: [] };
  const preposition = /^\s*(in|near)\s+/i.exec(match[0]);
  return { location: place, phrases: [`${preposition ? preposition[1] : "in"} ${place}`] };
}

export function parseSearchQuery(raw) {
  const request = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!request) return { ...EMPTY };
  const text = normalizeNumberWords(request);
  const budget = budgetFrom(text);
  const homeType = homeTypeFrom(text);
  const location = locationFrom(text);
  let preference = text;
  for (const phrase of [...budget.phrases, ...homeType.phrases, ...location.phrases]) {
    preference = preference.replace(phrase, " ");
  }
  preference = preference
    .replace(/\b(?:per|a|each)\s+month\b/gi, " ")
    .replace(/\bmonthly\b/gi, " ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, "")
    .trim();
  if (/^(?:for|with|in|near|and|or|a|an|the)$/i.test(preference)) preference = "";
  return {
    location: location.location ?? null,
    minPrice: budget.minPrice ?? null,
    maxPrice: budget.maxPrice ?? null,
    homeType: homeType.homeType ?? null,
    preference,
  };
}
