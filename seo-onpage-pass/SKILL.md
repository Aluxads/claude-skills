---
name: seo-onpage-pass
description: Run an on-page SEO pass on one page for one target keyword. 7 dimension onpage SEO checklist (title, H1, H2s, body, meta, alts, URL), SERP snapshot, baseline row in a change ledger, re-measure date. Use when the user says "on-page pass", "onpage seo checklist", "optimize this page for", "why does this page not rank", or before pushing any new page or title, H1, H2, meta change.
metadata:
  trigger: on-page pass, onpage seo checklist, new page before push, title or heading change, keyword to page mapping
---

# SEO on-page pass (one page, one keyword, one ledger row)

Rule of the pass: every SEO change is tracked so the read later can say what changed and what it did.
No change without (1) a baseline pulled BEFORE the edit, (2) a ledger row dated today, (3) a re-measure date and a revert rule.

## 1. Pick the keyword with data, not with the title you like

- Search Console: query rows for the page, 90 d (impressions, clicks, position). The keyword the page already gets impressions for beats the one you wish it ranked for.
- Search volume: Ubersuggest MCP `keyword_suggestions` (3 seeds per call, 3 reports per day on the free tier) or `keyword_overview`. Global lookup when unsure of the location id.
- Singular vs plural, digit vs word, "in" vs no "in": check both spellings in the query rows. Searchers often type the shorter one ("standing desk", "stand up desk").
- Two of your pages ranking for the same term = split, not a reason to merge. Decide which page owns the term, the other supports it with an anchor on existing text.

## 2. SERP check before touching the page

Run the `serp-teardown` skill for the keyword (needs a Serper key, see its SKILL.md), or use Ubersuggest `serp_analysis`, or a manual Google check in the target country.
Read: who owns the top 10 (a brand entity, a marketplace, a directory, a blog), where we sit, and whether the intent matches the page. A term owned by one brand (its site, maps, social profiles, a review directory) is not won with a title.

## 3. Run the checklist

```
node ~/.claude/skills/seo-onpage-pass/scripts/onpage-checklist.mjs <relative html path> "<target keyword>"
```
Run from the repo root (the path is relative to cwd). Needs `w3m` for the body text (`brew install w3m`). Output: 7 rows, PASS / PARTIAL / FAIL, plus every H2 and alt so the gap is visible.

Target: 7/7 or a documented reason per PARTIAL. Usual deliberate partials:
- H1 stays different from the title on purpose (H1 owns the plural or the visible brand line).
- Meta 130 to 149 chars when a pixel width rule (1000 px desktop cut) matters more than the 150 char floor.
- URL missing a stop word ("in").

## 4. Entity and question mine, before the H2 and FAQ work

Run the `serp-teardown` skill for the page's target keyword. Use its People Also Ask, related searches and top 10 competitor headings, plus image filter chips and Search Console question queries, as the coverage checklist for the H2s and FAQ block: each question becomes an H2 or H3, the direct answer sits in the first 40 to 60 words under it, entities go in only where true for the business.

## 5. Edit, in this order of impact

Title (keyword in the first 30 chars) > H1 > one H2 with the exact phrase > lead paragraph > meta (exact phrase first, then the offer) > one image alt > body 3+ mentions in natural sentences.
Mirror the title and meta into og:title, og:description, twitter and the WebPage JSON-LD name and description when they copy the meta.
Never inject sentences for links; anchor existing text only. Never a claim the page cannot back.

## 6. Ledger row (dated today, before the commit)

Suggested shape for a change ledger file (for example `docs/seo/change-ledger.md`):

```
## <ID>: <page>, <one line what> (<YYYY-MM-DD>, <ticket>, <approval state>)
**Baseline (<source>, <window>):** page impr / clicks / pos; each target query impr / clicks / pos; competitor page on the same term if any; checklist score before.
**Change (<branch or worktree>, <hand page or generator + JSON>):** exact before -> after per element. What was left untouched on purpose and why.
**Re-measure <date, 21 to 28 d>:** metric and target; failure rule = which element gets reverted; confound note if another change ships in the window.
```
Then refresh any on-page tracker sheet you keep so it carries the new title and meta.

## 7. After the push

Curl the live title, request indexing for a new URL, PSI mobile for a new page, put the read date in your calendar.

## Do not

- Change a page inside an open re-measure window (reaction discipline). Wait for the read.
- Chase position on a term whose SERP intent is a different business (for example a different business type) without a deliberate decision: impressions are cheap, the brand sits next to those results.
- Fold or merge two pages because they share a term. Give each its role first (conversion page vs guide vs info page).
