"""Offline contracts for the generic browsing policy text. No APIs, no browser.

The browsing policy is data: the model reads it as instructions for choosing one
operation and one target. These tests pin the clauses that stop the agent from
ending a search early, and assert the policy stays site-agnostic and value-free.
"""

import re

import pytest

from jev_ultrafast.questions import NEXT_ACTION, TARGET, browsing_policy

POLICY = browsing_policy()
FLAT = re.sub(r"\s+", " ", POLICY).lower()

# Each required clause is (description, exact phrases that must all appear).
REQUIRED_CLAUSES = [
    (
        "a set location stops further map/area/radius actions",
        ["do not adjust a map, search-area, or radius control again"],
    ),
    (
        "adjusting the map or area is not goal progress",
        ["adjusting the map or search area is not progress toward the goal"],
    ),
    (
        "a results-covering overlay is dismissed once, then results are reviewed",
        [
            "dismiss it once and then review the results area",
            "never toggle the same overlay repeatedly",
        ],
    ),
    (
        "the results region is inspected before declaring BLOCKED",
        ["inspect the visible results region before declaring blocked"],
    ),
    (
        "BLOCKED is barred while result cards are visible or a plausible control remains",
        [
            "do not choose blocked while matching result cards are visible",
            "could plausibly satisfy a requested filter",
        ],
    ),
    (
        "DONE is preferred when visible results already satisfy the request",
        ["choose done instead of adjusting the map, area, or filters further"],
    ),
]


@pytest.mark.parametrize("description,phrases", REQUIRED_CLAUSES)
def test_required_clauses_are_present(description, phrases):
    for phrase in phrases:
        assert phrase in FLAT, f"missing policy clause ({description}): {phrase!r}"


def test_existing_correct_rules_are_kept():
    preserved = [
        "done requires visible evidence that all requirements are satisfied",
        "a narrower available filter such as",
        '"posted today" is valid',
        "within four weeks",
        "do not toggle a checkbox, switch, or radio already in the requested state",
        "prefer a dedicated visible filter control over a broad search box",
    ]
    for phrase in preserved:
        assert phrase in FLAT, f"existing rule regressed: {phrase!r}"


@pytest.mark.parametrize("site", ["craigslist", "zillow", "redfin", "facebook"])
def test_no_site_specific_terms(site):
    assert site not in FLAT


def test_no_hardcoded_field_values_or_locations():
    # No numbers, currency, or example values from a failing run may be baked in.
    assert re.search(r"\d", POLICY) is None, "policy contains a hardcoded number"
    assert "$" not in POLICY, "policy contains a hardcoded money value"
    leaks = ["san francisco", "oakland", "min_price", "max_price", "postedtoday", "cat=apa"]
    for leak in leaks:
        assert leak not in FLAT, f"hardcoded value leaked into policy: {leak!r}"


def test_policy_contains_no_selectors_or_code():
    tokens = ["<", ">", "selector", "queryselector", "document.", "javascript:", "http://", "https://", "eval("]
    for token in tokens:
        assert token not in FLAT, f"policy looks executable, not prose: {token!r}"


def test_browsing_policy_helper_joins_operation_and_target_rules():
    policy = browsing_policy()
    assert isinstance(policy, str)
    assert NEXT_ACTION in policy and TARGET in policy
    assert policy == f"{NEXT_ACTION}\n\n{TARGET}"
    assert browsing_policy() == policy  # deterministic, no hidden state
