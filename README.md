# Claude skills by Aluxads: free Claude Code skills for marketing, SEO and sales ops

Free skills for Claude Code, built by Aluxads, a B2B growth agency. The focus is marketing, SEO and sales operations. Each skill is a folder with a `SKILL.md` and a `scripts/` directory.

## Skills in this repo

- `seo-onpage-pass`: on page SEO pass for one page and one keyword, scored on seven dimensions.
- `serp-teardown`: pulls Google page 1 for a batch of queries and shows what the rankers have in common.
- `autocomplete-mining`: mines Google autocomplete for a seed list with no AI tokens used for the data pull.
- `gsd-mode`: one command for an uninterrupted Claude Code working day, one git worktree per agent.
- `image-process`: one page image from a prompts doc slot to webp srcset, asset log row and paste snippet, with a render review stop.
- `secret-ledger`: names only check of env files and repos for leaked secrets, with scan, lint-env, intake and selftest.
- `conversion-tracking-audit`: audits GA4 key events, Google Ads conversion actions and offline readiness, scored report with a fix list.
- `search-term-review`: joins Google Ads search terms to CRM lead quality, lag aware, proposes negatives for sign off.

## Install

```
cp -R <skill name> ~/.claude/skills/<skill name>/
# example
cp -R seo-onpage-pass ~/.claude/skills/seo-onpage-pass/
```

Restart Claude Code. Each skill loads by name and by the trigger phrases in its `SKILL.md`.

## More

- Library page with every skill, install steps and FAQ: https://aluxads.com/resources/claude-skills/
- SEO skills for Claude Code: https://aluxads.com/resources/claude-skills/seo/

---

## Skills

### seo-onpage-pass

Runs an on page SEO pass for one page and one target keyword. A script scores seven dimensions (title, H1, H2s, body, meta description, image alts, URL) as PASS, PARTIAL or FAIL and lists every H2 and alt text. The skill also covers keyword choice from data, the SERP check before editing, the order of edits by impact, a change ledger row with a baseline, and a date to measure again with a revert rule.

Script: `scripts/onpage-checklist.mjs <html path> "<target keyword>"`. It needs `w3m` for the body text.

### autocomplete-mining

Mines Google autocomplete for a list of seed queries. It probes each seed with letters, prefixes and question words across one or more locales and writes `suggestions.csv`, `suggestions.json` and `run.json`. No AI tokens are used for the data pull. The skill then describes an analysis pass with an AI model, and `scripts/tag-and-cross.mjs` tags intent labels and crosses the rows with a Search Console keyword to page export.

Scripts: `scripts/mining.mjs`, `scripts/tag-and-cross.mjs`.

### serp-teardown

Takes a batch of queries and pulls Google page 1 for each. It fetches every ranking page, extracts on page facts (title, meta, headings, word count, schema, FAQ signals), and computes the consensus across rankers. It compares your own page against that consensus, clusters queries by shared top 10 URLs to answer whether two queries need one page or two, and writes a dated diff against the previous run. Blocked pages are listed and excluded from every count.

Script: `scripts/teardown.mjs`. Tests: `scripts/test.mjs`.

### gsd-mode

Switches Claude Code into an uninterrupted working day with one command. No session limit stops, no handoff unless you ask, agents pick only tasks that need no human decision (oldest first), each agent works in its own git worktree, and every question waits for a single list at the end. A flag file holds today's date, so the mode lasts the day across sessions and projects and switches itself off tomorrow.

Script: `scripts/gsd-mode-hook.mjs` (a `UserPromptSubmit` hook, install steps in the skill). Commands: `/gsd on`, `/gsd off`, `/gsd`.

### image-process

Takes one image slot from a prompts doc and runs it to a finished webp set. It generates the PNG through a shell command you set in `IMAGE_GEN_CMD`, then stops for your render review. After `--approve` it resizes to a webp srcset with ffmpeg (metadata stripped), checks each file against a byte limit, appends a row to an asset log and prints a paste ready srcset snippet with the alt text. Trigger: `/image-process`.

Script: `scripts/image-chain.mjs` (`--help` lists every flag). It needs `ffmpeg` and `ffprobe`.

### conversion-tracking-audit

Audits conversion tracking end to end for one site, one GA4 property and one Google Ads account: tags on the site, GA4 key events, Ads conversion actions (GA4 import, website tag, offline), whether every lead action fires once and counts as primary, and offline and enhanced conversion readiness. Writes a scored, dated report with a fix list and a sign off step. Read only by default, every write is a separate approval.

Script: `scripts/ads-conversion-actions.mjs` (read only GAQL list, env names passed by the caller). Template: `report-template.md`.

### search-term-review

Pulls Google Ads search terms with cost and conversions, joins them to CRM outcomes (which leads became customers), applies a lag model so recent spend is never called waste, classifies each term and writes a dated proposal of negatives with the spend each one saves. The agent never adds negatives itself; the account owner approves line by line.

Scripts: `scripts/search-terms.mjs` (GAQL pull to CSV), `scripts/join-crm.mjs` (pure node join and classification). Template: `report-template.md`.

## Install

Copy a skill folder into `~/.claude/skills/`:

```
cp -R seo-onpage-pass ~/.claude/skills/
cp -R autocomplete-mining ~/.claude/skills/
cp -R serp-teardown ~/.claude/skills/
cp -R gsd-mode ~/.claude/skills/
cp -R image-process ~/.claude/skills/
cp -R secret-ledger ~/.claude/skills/
```

Restart Claude Code. The skills load by name and by the trigger phrases in each `SKILL.md`.

## Requirements

- Node 18 or newer. The scripts use only the Node standard library, no `npm install`.
- A Serper key for serp-teardown, set as `SERPER_API_KEY` in the environment or in a `.env` file in the directory you run from. Serper gives 2,500 free credits and a query costs 1 credit. You can skip the key by passing your own results with `--serp file --serp-file results.json`.
- `w3m` for seo-onpage-pass (`brew install w3m` on macOS).
- `ffmpeg` and `ffprobe` for image-process, plus a generation command in `IMAGE_GEN_CMD` (for example the `openai images` CLI).
- Optional: Google Ads keyword metrics for serp-teardown through a client module you provide with `--ads-client <path>` (it is never auto discovered), or a metrics file. See the skill for details.
- Disclosure: autocomplete-mining calls Google's suggest endpoint, which is undocumented. Run it with a delay (250 ms minimum is enforced), at low volume, from your own IP, and check Google's terms for your use.

## Check the install

```
node ~/.claude/skills/serp-teardown/scripts/test.mjs
node ~/.claude/skills/serp-teardown/scripts/teardown.mjs --help
```

## License

MIT. See `LICENSE`.
