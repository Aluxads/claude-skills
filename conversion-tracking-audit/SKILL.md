---
name: conversion-tracking-audit
description: Audit conversion tracking end to end for one site, one GA4 property and one Google Ads account. Inventories tags, GA4 key events, Ads conversion actions (GA4 import, website tag, offline), checks every lead action fires once and is primary, checks offline and enhanced conversion readiness, then writes a scored dated report with a fix list and sign off. Read only by default. Use when the user says "/conversion-tracking-audit", "conversion tracking audit", "are my conversions tracked", "audit my GA4 and Google Ads conversions", or before scaling ad spend.
metadata:
  trigger: /conversion-tracking-audit, conversion tracking audit, are my conversions tracked
  inputs: GA4 property, Google Ads customer id, site URL, optional CRM export
  output: conversion-tracking-audit-YYYY-MM-DD.md
---

# Conversion tracking audit

## 1. Purpose
Prove that every lead action on the site is recorded once in GA4, reaches Google Ads as a primary conversion, and that offline sales can be sent back. Bad tracking makes bidding optimise for the wrong thing, so run this before raising budget or judging a campaign.

Read only by default. Every write (set primary, create action, change a window) is a separate approval, named in the report.

## 2. Inputs
Ask for what is missing, never guess.
- Site URL (live, public).
- GA4 property id (numeric) and read access.
- Google Ads customer id (10 digits) and, if used, the manager (login) id.
- Optional: CRM lead export (CSV) with a click id column, lead date, stage, won flag.
- Credentials come from env var names the caller passes: `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID`. Print names only, never values. No credentials = do phases 1, 2, 4 from the UI and mark phase 3 "manual".

## 3. Procedure

### Phase 1: tag inventory (site)
Fetch the home page, one money page, the lead form page and the thank you state. Look in HTML and loaded scripts for:
- `gtag.js` (`G-` measurement id, `AW-` Ads id), GTM container (`GTM-`), a hard coded Ads conversion call (`gtag('event','conversion',{send_to:'AW-.../label'})`).
- Consent: a consent banner, Consent Mode v2 defaults (`ad_storage`, `analytics_storage`, `ad_user_data`, `ad_personalization`), and whether tags wait for consent.
- The same measurement id loaded twice (GTM plus hard coded gtag) = double counted page views and events.
- Measurement id matches the GA4 property given.
Score: tag present and single, ids correct, consent defaults set, fires on the thank you state not on page load of the form.

### Phase 2: GA4 key events
List events marked key (formerly conversions) via GA4 Admin API `keyEvents` or the UI. For each lead action record: event name, the trigger that fires it (form submit, thank you page, booking callback, click), counting method (once per event or once per session), and parameters (`value`, `currency`).
- Test by submitting the form once (or use DebugView / Realtime) and confirm exactly one event.
- Flag key events that are not leads (clicks, scrolls) marked key: they pollute imported conversions.
- Flag lead actions that exist as events but are not marked key.

### Phase 3: Google Ads conversion actions
Run `node ~/.claude/skills/conversion-tracking-audit/scripts/ads-conversion-actions.mjs <customer-id>` (add `--json` to save the raw rows). It runs GAQL on `conversion_action` and returns: id, name, type, status, category, origin, `primary_for_goal`, `counting_type`, `include_in_conversions_metric`, click through and view through lookback days, attribution model, default value, and `google_analytics_4_settings` (`event_name`, `property_name`, `property_id`).
Classify each action by source:
- GA4 import: type GA4 custom or GA4 purchase, has `google_analytics_4_settings`.
- Website tag: type `WEBPAGE` (or Ads tag), fires from the Ads conversion tag.
- Offline: type upload clicks / upload calls / import from CRM, or enhanced conversions for leads.
Check per action:
- Primary vs secondary: only primary actions (`primary_for_goal` true, in the matching goal) feed bidding. A lead action that is secondary does not optimise campaigns. A non lead action (page view, click) that is primary skews bidding.
- Counting: lead actions should be `ONE_PER_CLICK`; `MANY_PER_CLICK` suits purchases only.
- Click through window: match the sales cycle (default 30 days; B2B with long cycles needs 60 to 90). View through 1 day unless a reason exists.
- Attribution: data driven where eligible, else last click; same model across actions that compete.
- Status `HIDDEN` or `REMOVED` on an action that is still expected = broken link, flag it.
- Value: lead actions carry a default value or a real value, not 0 and not a placeholder, if value based bidding is planned.

### Phase 4: cross check
Build one row per lead action (form, call, booking, chat):
1. Fires in GA4 once (phase 2).
2. Exists in Ads as an enabled action (phase 3).
3. Is primary in the right goal.
4. Counted once: the same real action must not arrive through two paths (GA4 import plus website tag plus GTM tag for the same form). Duplicate signs: two enabled actions with the same GA4 `event_name`, an Ads website tag and a GA4 import on the same event, Ads conversions roughly double GA4 events for the same period.
5. Volumes within sanity: compare 28 day GA4 key events with Ads conversions for the same action; a gap over 30 percent needs an explanation (consent loss, import lag, attribution window, non Google traffic).
Fix duplicates by demoting one path to secondary or removing it, never by deleting history.

### Phase 5: offline conversions and enhanced conversions for leads
Readiness checks, no uploads in an audit:
- Click id capture: forms store `gclid`, plus `gbraid` and `wbraid`, from the landing URL into hidden fields; first party storage survives the multi page journey; the id reaches the CRM lead record.
- CRM: stage field, won flag, revenue, and lead date; export shows what share of won leads have a click id (under 60 percent = weak).
- Upload path: Ads API, Google Sheets or scheduled file import, or CRM native connector; who runs it; last upload date; the conversion action type used for offline data.
- Upload lag: uploads must land within the conversion window; late uploads past the window are dropped.
- Enhanced conversions for leads: enabled in settings, customer data terms accepted, hashed (SHA256) email or phone sent with the lead event or uploaded with the conversion.
- Privacy: consent gating applied to the data sent.

### Phase 6: scored report
Fill `report-template.md`, save as `conversion-tracking-audit-YYYY-MM-DD.md` in the folder the caller names (default current directory). Score with the rubric below, list a fix list ordered by severity, list what could not be verified, then the sign off block.

## 4. Score rubric (100 points)

| Phase | Max | Full marks when |
|---|---|---|
| 1 Tags | 20 | one tag path, ids correct, consent defaults set, fires on success state |
| 2 GA4 key events | 15 | every lead action is a key event, fires once, carries value and currency, no junk key events |
| 3 Ads actions | 20 | every lead action enabled and primary, counting, windows and attribution fit the sales cycle |
| 4 Cross check | 20 | no duplicates, GA4 vs Ads volumes within 30 percent, no lead action missing on either side |
| 5 Offline readiness | 25 | click id on every form and in the CRM, upload path running, enhanced conversions on |

Grade: 90 to 100 A, 75 to 89 B, 55 to 74 C, under 55 D. A missing primary lead action or a confirmed duplicate caps the grade at C regardless of points.
Severity: blocker = lead action not tracked or double counted; high = secondary lead action, no click id capture; medium = window or attribution mismatch, missing value; low = naming, hygiene.

## 5. What the Ads API can and cannot do
- Read: GAQL on `conversion_action` works for all types.
- Update: `primary_for_goal`, `status`, windows, counting, value settings can be changed with a `conversionActions:mutate` update plus `updateMask`. Always dry run first with `validateOnly: true`.
- Cannot create GA4 import actions: a create with a GA4 type returns `CREATION_NOT_SUPPORTED`. They are created in the Ads UI (Goals, Conversions, New conversion action, Import, Google Analytics 4, Web) or appear automatically once the GA4 key event exists and the property is linked to the Ads account.
- Enum gaps: some GA4 imported actions read `UNKNOWN` for type in newer API versions. Treat as harmless, confirm in the UI.
- Link check: the GA4 property needs an active Google Ads link (GA4 Admin API `googleAdsLinks`); a canceled link next to an active one is normal; note whether ads personalization is enabled.
- Website tag and offline actions can be created by API, but only after approval.

## 6. Guardrails
- Read only unless the caller approves a named write. One approval = one action on one id; record it under Sign off.
- Never print or store secrets; env var names only. Do not paste tokens, customer lists or raw CRM rows into the report; aggregate counts only.
- Never submit forms on a live site more than once for a test, and mark the test lead in the CRM.
- Never delete or recreate a conversion action to fix a count: history is lost. Demote to secondary instead.
- Changes to primary status shift bidding within hours: warn the caller, suggest a quiet window, and re audit 28 days later.
- Report facts only: if a value could not be read, write "not verified" with the reason.

## 7. Files
- `scripts/ads-conversion-actions.mjs`: GAQL list of conversion actions (Node 18 or newer, no dependencies, read only).
- `report-template.md`: report skeleton.
