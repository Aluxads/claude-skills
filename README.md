# Claude skills by Aluxads: free Claude Code skills for marketing, SEO and sales ops

Free skills for Claude Code, built by Aluxads, a B2B growth agency. The focus is marketing, SEO and sales operations. Each skill is a folder with a `SKILL.md` and a `scripts/` directory.

## Skills in this repo

- `seo-onpage-pass`: on page SEO pass for one page and one keyword, scored on seven dimensions.
- `serp-teardown`: pulls Google page 1 for a batch of queries and shows what the rankers have in common.
- `autocomplete-mining`: mines Google autocomplete for a seed list with no AI tokens used for the data pull.
- `gsd-mode`: one command for an uninterrupted Claude Code working day, one git worktree per agent.

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

## Install

Copy a skill folder into `~/.claude/skills/`:

```
cp -R seo-onpage-pass ~/.claude/skills/
cp -R autocomplete-mining ~/.claude/skills/
cp -R serp-teardown ~/.claude/skills/
cp -R gsd-mode ~/.claude/skills/
```

Restart Claude Code. The skills load by name and by the trigger phrases in each `SKILL.md`.

## Requirements

- Node 18 or newer. The scripts use only the Node standard library, no `npm install`.
- A Serper key for serp-teardown, set as `SERPER_API_KEY` in the environment or in a `.env` file in the directory you run from. Serper gives 2,500 free credits and a query costs 1 credit. You can skip the key by passing your own results with `--serp file --serp-file results.json`.
- `w3m` for seo-onpage-pass (`brew install w3m` on macOS).
- Optional: Google Ads keyword metrics for serp-teardown through a client module you provide with `--ads-client <path>` (it is never auto discovered), or a metrics file. See the skill for details.
- Disclosure: autocomplete-mining calls Google's suggest endpoint, which is undocumented. Run it with a delay (250 ms minimum is enforced), at low volume, from your own IP, and check Google's terms for your use.

## Check the install

```
node ~/.claude/skills/serp-teardown/scripts/test.mjs
node ~/.claude/skills/serp-teardown/scripts/teardown.mjs --help
```

## License

MIT. See `LICENSE`.
