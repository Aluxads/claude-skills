# Conversion tracking audit: <site or business>, <YYYY-MM-DD>

Scope: site <url>, GA4 property <id>, Ads customer <id>, CRM export <yes/no>.
Mode: read only. Writes made: none (list each approved write under Sign off).

## Score

| Phase | Max | Score | One line |
|---|---|---|---|
| 1 Tags on the site | 20 | | |
| 2 GA4 key events | 15 | | |
| 3 Ads conversion actions | 20 | | |
| 4 Cross check, duplicates | 20 | | |
| 5 Offline and enhanced readiness | 25 | | |
| Total | 100 | | Grade: |

## 1 Tag inventory

| Tag | Where found | ID | Fires on | Consent gated | Note |
|---|---|---|---|---|---|

## 2 GA4 key events

| Event | Key event | Definition (trigger) | Fires in test | Params (value, currency) | Note |
|---|---|---|---|---|---|

## 3 Ads conversion actions

| Id | Name | Source (GA4 import / website tag / offline) | Status | Primary | Counting | Click window | Attribution | Note |
|---|---|---|---|---|---|---|---|---|

## 4 Cross check

| Lead action | In GA4 | In Ads | Primary | Counted once | Verdict |
|---|---|---|---|---|---|

Duplicates found: <list or none>.

## 5 Offline and enhanced conversions

| Check | Result | Evidence |
|---|---|---|
| GCLID (and GBRAID, WBRAID) captured on every lead form | | |
| Click id stored with the lead record in the CRM | | |
| Upload path (API, scheduled import, manual) and last upload date | | |
| Enhanced conversions for leads enabled, hashed email or phone sent | | |
| Customer data terms accepted | | |
| Lag between lead and upload known | | |

## Fix list

| # | Fix | Severity (blocker / high / medium / low) | Needs write approval | Owner | Done |
|---|---|---|---|---|---|

## Cannot verify

- <item and why>

## Sign off

- Reviewed by: <name>, <date>
- Approved writes: <list with exact action and id, or none>
- Re-audit date: <date, 28 days out or after the next fix ships>
