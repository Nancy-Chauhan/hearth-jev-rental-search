// Deterministic contracts for turning a spoken/typed request into sidebar filters.
// Run with: node --test tests/query.test.js

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseSearchQuery } from "../jev_ultrafast/static/query.js";

const budget = (text) => {
  const { minPrice, maxPrice } = parseSearchQuery(text);
  return [minPrice, maxPrice];
};

test("an upper bound sets only the maximum", () => {
  assert.deepEqual(budget("under $2,500"), [null, 2500]);
  assert.deepEqual(budget("below 2500"), [null, 2500]);
  assert.deepEqual(budget("less than 3k"), [null, 3000]);
  assert.deepEqual(budget("no more than $2,000 a month"), [null, 2000]);
});

test("a lower bound sets only the minimum", () => {
  assert.deepEqual(budget("over $1,000"), [1000, null]);
  assert.deepEqual(budget("at least 1500"), [1500, null]);
});

test("ranges are recognized in every common phrasing", () => {
  assert.deepEqual(budget("between $1,500 and $2,500"), [1500, 2500]);
  assert.deepEqual(budget("$1,800 to $2,400"), [1800, 2400]);
  assert.deepEqual(budget("2000-3000"), [2000, 3000]);
  assert.deepEqual(budget("over $1,000 and under $3,000"), [1000, 3000]);
  assert.deepEqual(budget("between two thousand and three thousand"), [2000, 3000]);
});

test("spoken and abbreviated amounts normalize", () => {
  assert.deepEqual(budget("under twenty five hundred"), [null, 2500]);
  assert.deepEqual(budget("under 2.5k"), [null, 2500]);
});

test("a bare amount only counts as a budget when the request says so", () => {
  assert.deepEqual(budget("my budget is 3000"), [null, 3000]);
  assert.deepEqual(budget("3000"), [null, null]);
  assert.deepEqual(budget("1200 sqft"), [null, null]);
  assert.deepEqual(budget("under $3,000 with 1200 sqft"), [null, 3000]);
});

test("home type is read from apartment, studio, and house words", () => {
  assert.equal(parseSearchQuery("studio near BART").homeType, "studio");
  assert.equal(parseSearchQuery("2 bedroom apartment").homeType, "flat");
  assert.equal(parseSearchQuery("a condo with parking").homeType, "flat");
  assert.equal(parseSearchQuery("single family house").homeType, "house");
  assert.equal(parseSearchQuery("apartment or house").homeType, null);
});

test("location is read from a capitalized place after in/near", () => {
  assert.equal(parseSearchQuery("in Oakland").location, "Oakland");
  assert.equal(parseSearchQuery("a flat in San Francisco, CA").location, "San Francisco");
  assert.equal(parseSearchQuery("in Oakland for under $2,500").location, "Oakland");
});

test("a transit or amenity phrase is not mistaken for a location", () => {
  assert.equal(parseSearchQuery("near BART").location, null);
  assert.equal(parseSearchQuery("studio near BART").location, null);
});

test("the remainder stays as the free-text preference", () => {
  const parsed = parseSearchQuery("studio in Oakland under $2,500 per month, near BART");
  assert.deepEqual(parsed, {
    location: "Oakland",
    minPrice: null,
    maxPrice: 2500,
    homeType: "studio",
    preference: "near BART",
  });
  assert.equal(parseSearchQuery("under $2,500").preference, "");
  assert.equal(parseSearchQuery("apartment for under $2,500").preference, "");
});

test("a pure preference request changes nothing", () => {
  assert.deepEqual(parseSearchQuery("lots of light near BART"), {
    location: null,
    minPrice: null,
    maxPrice: null,
    homeType: null,
    preference: "lots of light near BART",
  });
  assert.deepEqual(parseSearchQuery("   ").preference, "");
  assert.deepEqual(parseSearchQuery(""), {
    location: null,
    minPrice: null,
    maxPrice: null,
    homeType: null,
    preference: "",
  });
});
