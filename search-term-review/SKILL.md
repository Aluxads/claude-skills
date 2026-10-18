---
name: search-term-review
description: Review Google Ads search terms against CRM lead quality. Pulls search terms with cost and conversions, joins them to CRM outcomes (which leads became customers), applies a lag model so recent spend is never called waste, classifies each term, and writes a dated proposal of negatives with the spend each saves. The agent never adds negatives itself; the account owner approves line by line, then a separate apply step runs. Use when the user says "/search-term-review", "search term review", "which keywords waste money", "negatives from lead quality", or before cutting spend on a lead generation account.
metadata:
  trigger: /search-term-review, search term review, which keywords waste money, negatives from lead quality
  inputs: Google Ads customer id, date range, CRM export CSV
  output: search-term-review-YYYY-MM-DD.md
---

# Search term review tied to CRM lead quality

## 1. Purpose
Judge search terms by which leads became customers, not by platform conversions alone. A term with clicks and form fills can still be pure waste; a term with no platform conversion can feed the best customers. The lag model stops the review from calling recent spend waste before the leads have had time to close.

Read only. The agent writes a proposal. The account owner signs it. Applying negatives is a separate step with its own approval.

## 2. Inputs
Ask for what is missing, never guess.
- Google Ads customer id (10 digits) and the manager (login) id if used.
- Date range: 60 to 120 days is typical. It must start earlier than the lag window so mature spend exists.
- CRM export (CSV), at minimum: lead id or click id, created date, stage or outcome. Optional: deal value.
- The bridge from a CRM lead back to a search term. A click id alone does not name a search term. One of:
  - a CRM column holding the term (a `utm_term` or ValueTrack `{keyword}` / search term passed on the landing URL and stored with the lead), or
  - a map file (click id to search term) built from GA4, a landing log or a click export, passed as `--gclid-map`.
  No bridge = stop at phase 1 and report spend only; say so in the report.
- Lag days: how long a lead needs to reach qualified or closed. Ask for it; default 30. Take it from the CRM (median created to closed date of won leads, then round up).
- The stage values that mean a customer (for example `closed`, `customer`).
- Credentials come from env var names the caller passes: `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID`. Print names only, never values. No credentials = ask for a search terms CSV export in the same columns.

## 3. Procedure

### Phase 1: pull search terms
`node ~/.claude/skills/search-term-review/scripts/search-terms.mjs <customer-id> --from YYYY-MM-DD --to YYYY-MM-DD > terms.csv` (or `--days 90`). Uses GAQL on `search_term_view`: date, search term, status (added, excluded, none), campaign, ad group, cost, clicks, impressions, conversions, conversion value. Daily rows, so the lag model can split spend by age. Stderr shows row count and total cost; check it against the Ads UI for the same range.
Keep files in a local working folder, not in the report folder.

### Phase 2: join to CRM outcomes
Run phase 3 and 4 in one command, the script does both:
`node ~/.claude/skills/search-term-review/scripts/join-crm.mjs --terms terms.csv --crm crm.csv --term-col <col> --date-col <col> --stage-col <col> [--value-col <col>] --won-values "closed,customer" --lag-days 30 > classified.csv`
With a map file instead of a term column: `--gclid-col <col> --gclid-map map.csv`. Terms match after lowercase and whitespace normalisation. Read the stderr counts: CRM rows matched, out of range, no bridge, term not in spend. A match rate under 50 percent of in range leads = the bridge is weak, say so and do not push hard conclusions.
Matching is by term across all campaigns; a term running in two campaigns appears once with both names listed.

### Phase 3: lag model
Spend on or after `as-of minus lag days plus 1` is "young". Young spend is never counted as waste. A term whose mature clicks are below the minimum is "too young", not "zero lead". Leads created in the young window count as leads but may not have closed yet; terms with only young leads stay in "leads only" with a watch note. Set `--as-of` to the CRM export date if the terms file ends earlier.

### Phase 4: classify
Each term gets one class:

| Class | Rule | Default action |
|---|---|---|
| converting_to_customers | at least one matched lead reached a won stage | keep, consider exact match, protect budget |
| converting_to_leads_only | matched leads, none won yet | keep, watch lead quality, re-run after the lag window |
| zero_lead | no matched lead, mature clicks at or above minimum | negative candidate |
| too_young | no matched lead, but the spend is mostly inside the lag window | do not judge |
| low_volume | total clicks under minimum (default 10) | no call yet |

Check the platform side as a sanity read: a term with platform conversions but zero CRM leads points to junk form fills or a tracking gap; list these for follow up before adding negatives.

### Phase 5: propose negatives and budget notes
Only `zero_lead` terms are candidates. For each candidate:
- Saved spend = its mature cost in the range (the report also shows it per 30 days).
- Match type: exact when the term is a one off; phrase when a shared word or stem recurs across several zero lead terms (for example every term holding the same off intent word). Check a phrase negative against the `converting_to_customers` and `converting_to_leads_only` lists first: if any customer term contains the phrase, do not propose it.
- Level: campaign negative when the term is off intent only for that campaign; shared negative list when it is off intent for the whole account (jobs, free, courses, DIY).
- Add bid or budget notes: customer terms that are capped by budget, leads only terms with a high cost per lead, ad groups where most spend sits in zero lead terms.
Totals: saved spend over the range, percent of total spend, and the lag cutoff date used.

### Phase 6: sign off
Fill `report-template.md` and save `search-term-review-YYYY-MM-DD.md` in the folder the caller names (default current directory). The proposal table has an Approved column that stays empty. The agent stops here and waits.
Apply is a separate step, run only after the account owner marks lines approved:
1. Take only lines marked approved, exact text, level and match type as written.
2. Apply through the Ads UI, or by API as a `campaignCriteria:mutate` / `sharedCriteria:mutate` call with `validateOnly: true` first, then the real call after a second go.
3. Record the batch under Sign off: date, who approved, count, list name.
4. Set a re review date: the lag window after the change, so the effect is judged on mature data.

## 4. Guardrails
- Read only. The agent never adds, removes or changes negatives, bids or budgets on its own. One approval covers one named batch.
- Privacy: CRM rows stay local. The report shows counts, terms, cost and stage totals, never contact names, emails, phone numbers or lead ids. Delete working CSVs when done unless the owner wants them kept.
- Never call a term waste on young spend. Never propose a phrase negative that would block a customer term.
- Thin data: under the minimum clicks, or a CRM sample under about 30 leads, say "no call" instead of ruling.
- Branded terms and the business's own name are never negative candidates; list them as protected.
- Report facts only: a value that could not be read is "not verified" with the reason.

## 5. Files
- `scripts/search-terms.mjs`: GAQL pull of `search_term_view`, daily CSV to stdout (Node 18 or newer, no dependencies, read only).
- `scripts/join-crm.mjs`: joins terms to a CRM CSV, applies the lag model, writes the classification CSV (local only, no network, no dependencies). Flags: `--term-col`, `--gclid-col` with `--gclid-map`, `--date-col`, `--stage-col`, `--value-col`, `--won-values`, `--lag-days`, `--as-of`, `--min-clicks`.
- `report-template.md`: report skeleton.
