// Pure, DOM-free report logic. Shared by the Hearth UI and the Node report tests.
// Keep this file free of browser APIs so `node --test` can import it directly.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

export function priceValue(price) {
  const match = String(price ?? "").match(/[\d,]+/);
  if (!match) return null;
  const value = Number(match[0].replaceAll(",", ""));
  return Number.isFinite(value) ? value : null;
}

const PRIVATE_ROOM =
  /\b(private room|room for rent|rooms?\s*&\s*shares?|roommate|shared room|single room|share[d]? (?:a )?room|shared (?:bathroom|kitchen)|common kitchen|sro|single.room occupancy|habitaci[oó]n (?:privada|en alquiler)|cuarto (?:en renta|en alquiler)|chambre (?:priv[eé]e|[aà] louer))\b/i;

export function isPrivateRoom(text) {
  return PRIVATE_ROOM.test(String(text ?? ""));
}

const HOUSE_WORDS = /\b(houses?|townhomes?|townhouses?|duplex)\b/i;
const FLAT_WORDS = /\b(apartments?|flats?|condos?|lofts?)\b/i;
const STUDIO_WORD = /\bstudios?\b/i;
// "1BD", "2BR", "1 Bedroom", "Home", "unit" all describe a self-contained rental.
const BEDROOM_WORDS = /\b\d+\s*(?:bd|br|beds?|bedrooms?)\b|\b(?:one|two|three|four)\s+bedrooms?\b/i;
const DWELLING_WORDS = /\b(homes?|units?|residences?)\b/i;

// pass = consistent with the request, fail = contradicts it, unknown = no signal.
export function homeCheck(requestedType, text) {
  const value = String(text ?? "").toLowerCase();
  const type = String(requestedType ?? "").toLowerCase();
  const studio = STUDIO_WORD.test(value);
  const house = HOUSE_WORDS.test(value);
  const flat = FLAT_WORDS.test(value);
  const sleeping = BEDROOM_WORDS.test(value);
  const dwelling = DWELLING_WORDS.test(value);
  if (type === "studio") {
    if (studio) return "pass";
    if (house || flat || sleeping) return "fail";
    return "unknown";
  }
  if (type === "house") {
    if (house) return "pass";
    if (flat || studio) return "fail";
    return "unknown";
  }
  // A flat is the default request: a house-only card contradicts it.
  if (house && !flat && !studio) return "fail";
  if (flat || studio || sleeping || dwelling) return "pass";
  return "unknown";
}

export function mismatchesHomeType(requestedType, text) {
  return homeCheck(requestedType, text) === "fail";
}

// Missing facts stay visible as unavailable instead of being silently dropped.
export function listingFacts(listing) {
  return ["beds", "baths", "sqft"].map((label) => {
    const value = listing?.[label];
    return { label, value, available: Boolean(String(value ?? "").trim()) };
  });
}

const completeness = (listing) =>
  [listing.image, listing.beds, listing.baths, listing.sqft].filter(Boolean).length;

export function rankListings(listings) {
  const priceOf = (listing) => listing.priceValue ?? priceValue(listing.price) ?? Infinity;
  return [...listings].sort(
    (left, right) => completeness(right) - completeness(left) || priceOf(left) - priceOf(right),
  );
}

// Round-robin across sources so one site cannot crowd the others out of a small report.
export function balanceSources(ranked, limit) {
  const buckets = new Map();
  for (const listing of ranked) {
    if (!buckets.has(listing.source)) buckets.set(listing.source, []);
    buckets.get(listing.source).push(listing);
  }
  const sources = [...buckets.keys()];
  const picked = [];
  while (picked.length < limit) {
    let added = false;
    for (const source of sources) {
      const bucket = buckets.get(source);
      if (!bucket.length) continue;
      picked.push(bucket.shift());
      added = true;
      if (picked.length >= limit) break;
    }
    if (!added) break;
  }
  return picked;
}

export function canonicalListingUrl(href) {
  try {
    const url = new URL(href);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.href;
  } catch { return String(href || ""); }
}

// Detail-page facts only fill gaps, or replace a card value the card itself flagged as uncertain.
export function mergeDetail(listing, detail) {
  const merged = { ...(listing || {}) };
  for (const key of ["beds", "baths", "sqft", "address"]) {
    if (detail?.[key]) merged[key] = detail[key];
  }
  const uncertain = /\+|\bfrom\b|starting|[-–]\s*\$?\d/i.test(String(merged.price || ""));
  if (detail?.price && (!merged.price || uncertain)) merged.price = detail.price;
  if (detail?.title && String(merged.title || "").length < 12) merged.title = detail.title;
  if (detail?.description) merged.description = detail.description;
  // Never replace a card date we can already read with a page phrase we may not.
  if (detail?.posted && !merged.posted_text) merged.posted_text = detail.posted;
  if (detail?.amenities?.length) merged.amenities = detail.amenities;
  merged.enriched = true;
  return merged;
}

const cityName = value => String(value || "").split(",")[0].trim().toLowerCase()
  .replace(/^sf$/, "san francisco").replace(/[^a-z\s'-]/g, "");

export function locationCheck(listing, requested) {
  if (!requested) return "pass";
  const city = cityName(requested);
  if (listing.location) return cityName(listing.location) === city ? "pass" : "fail";
  // A full "City, ST" anywhere in the listing's own words is evidence; prose alone is not
  // used for the looser "named city" fallback below.
  const text = [listing.address, listing.title, listing.summary, listing.description].filter(Boolean).join("\n");
  const places = [...text.matchAll(/\b([A-Z][a-z]+(?: [A-Z][a-z]+){0,2}),\s*[A-Z]{2}\b/g)]
    .map(match => cityName(match[1]));
  if (places.length) {
    const matches = places.map(place => place === city || place.endsWith(` ${city}`));
    return matches.every(Boolean) ? "pass" : matches.some(Boolean) ? "unknown" : "fail";
  }
  // A named city in an address/title is evidence; a nearby-city mention in prose is not.
  const primary = cityName(`${listing.address || ""} ${listing.title || ""}`);
  return primary.includes(city) && city.length > 2 ? "pass" : "unknown";
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function parseAge(text, now) {
  if (!text) return null;
  if (/\btoday\b/i.test(text)) return 0;
  if (/\byesterday\b/i.test(text)) return 1;
  const relative = text.match(/(?:<\s*)?(\d+)\s*(minutes?|mins?|hours?|hrs?|h|days?|d|weeks?)\s+ago\b/i);
  if (relative) {
    const factor = /^m/i.test(relative[2]) ? 1 / 1440 : /^h/i.test(relative[2]) ? 1 / 24 : /^w/i.test(relative[2]) ? 7 : 1;
    return Number(relative[1]) * factor;
  }
  // A written month ("September 20" or "Sep 20, 2026") is as good as 9/20.
  const named = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b(?:,?\s*(\d{4}))?/i);
  if (named) {
    const month = MONTHS.indexOf(named[1].toLowerCase());
    const day = Number(named[2]);
    const stamp = new Date(named[3] ? Number(named[3]) : new Date(now).getFullYear(), month, day);
    if (stamp.getMonth() === month && stamp.getDate() === day) {
      if (!named[3] && stamp.getTime() > now) stamp.setFullYear(stamp.getFullYear() - 1);
      return (now - stamp.getTime()) / 86400000;
    }
  }
  const date = text.match(/(?:^|\s)(\d{1,2})\/(\d{1,2})(?:\s|$)/);
  if (date) {
    const today = new Date(now);
    const stamp = new Date(today.getFullYear(), Number(date[1]) - 1, Number(date[2]));
    if (stamp.getMonth() !== Number(date[1]) - 1 || stamp.getDate() !== Number(date[2])) return null;
    if (stamp > today) stamp.setFullYear(stamp.getFullYear() - 1);
    return (now - stamp.getTime()) / 86400000;
  }
  return null;
}

export function listingAgeDays(listing, now = Date.now()) {
  if (listing.posted_at) {
    const stamp = Date.parse(listing.posted_at);
    if (Number.isFinite(stamp) && stamp <= now) return (now - stamp) / 86400000;
  }
  // A card's own <time> can be truncated ("about 16", with the unit in a nested node), so the
  // card text is a second chance rather than a discarded alternative.
  for (const candidate of [listing.posted_text, listing.summary]) {
    const age = parseAge(String(candidate || ""), now);
    if (age != null) return age;
  }
  return null;
}

export function selectListings({ groups, minPrice, maxPrice, requestedType, location, daysListed, now = Date.now(), limit = 18 }) {
  const seen = new Set();
  const kept = [];
  const countsBySource = {};
  const excluded = [];
  let scanned = 0;
  for (const { source, listings } of groups) {
    for (const listing of listings || []) {
      if (!listing?.href) continue;
      scanned += 1;
      const key = canonicalListingUrl(listing.href);
      let reason = seen.has(key) ? "Duplicate removed" : null;
      seen.add(key);
      const value = priceValue(listing.price);
      const text = `${listing.title ?? ""} ${listing.summary ?? ""}`.toLowerCase();
      const place = locationCheck(listing, location);
      const age = listingAgeDays(listing, now);
      const recent = !daysListed ? "pass" : age == null ? "unknown" : age <= daysListed ? "pass" : "fail";
      reason ||= isPrivateRoom(text) ? "Excluded: room or shared facilities"
        : mismatchesHomeType(requestedType, text) ? "Different home type"
        : value != null && (value < minPrice || value > maxPrice) ? "Outside your budget"
        : place === "fail" ? "Outside your requested city"
        : recent === "fail" ? "Older than requested" : null;
      if (reason) {
        excluded.push({ ...listing, source, key, reason });
        continue;
      }
      // No usable price cannot be presented as an in-budget result.
      if (value == null) {
        excluded.push({ ...listing, source, key, reason: "Price unavailable" });
        continue;
      }
      const unit = homeCheck(requestedType, text);
      const checks = {
        price: /\+|\bfrom\b|starting|[-–]\s*\$?\d/.test(listing.price) ? "unknown" : "pass",
        location: place,
        home: unit,
        recency: recent,
      };
      const qualified = Object.values(checks).every(check => check === "pass");
      kept.push({ ...listing, source, key, priceValue: value, checks, qualified, ageDays: age });
      countsBySource[source] = (countsBySource[source] ?? 0) + 1;
    }
  }
  const qualified = rankListings(kept.filter(item => item.qualified));
  const pending = rankListings(kept.filter(item => !item.qualified));
  const listings = [...balanceSources(qualified, limit), ...balanceSources(pending, Math.max(0, limit - qualified.length))].slice(0, limit);
  return { listings, matches: kept.length, qualified, pending, excluded, scanned, countsBySource, shown: listings.length };
}
