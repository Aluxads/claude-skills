---
name: secret-ledger
description: Names only checks that every env secret has a ledger row with owner login, expiry, consumers and env label. CLI with check (one project or --all), scan, lint-env, intake, selftest; never prints a value.
verified: 2026-10-18
---

# Secret ledger

## 1. When to use
- Hooks that call this skill (example wiring): Claude SessionStart + UserPromptSubmit (`check --quick --hook [--cached]`), git pre-commit in three repos (`check --staged`), git pre-push in the site repo (full `check`, WARN quiet, FAIL blocks). All skip silently when the skill folder is missing.
- A new env key appears, or a session, commit or push needs proof that every key has a ledger row.
- Before a rotation: which files consume a key.
- Env file hygiene: comment rules, group banners, file mode, stale copies.

## 2. Setup
1. Put `.secret-ledger.json` in the project root (gitignore it if the repo is public). Required keys: `project`, `prefix`, `envFiles`, `ledger`. Optional: `secretDirs`, `scanInclude`, `scanExclude`, `namingRegex`, `stateDir`, `columnMap`, `stores`, `redactExtra`. Unknown keys exit 2.
2. Ledger = markdown table with the fixed columns: `name, project, provider, account, env, kind, purpose, scope, consumers, source, shared_with, copies, created, expires, rotation_trigger, rotation_steps, verify, last_verified, status, history_ref`.
3. Legacy ledger: set `columnMap` (fixed column to legacy header; optional `table` = heading text or first header cell that picks the table, else the first matching table). Unmapped columns count as open fields, tagged `migration`, never FAIL. Remove the map once the table is migrated.

## 3. Commands
Base: `node ~/.claude/skills/secret-ledger/scripts/ledger.mjs <command>`. Default `--project` = current directory.

| Command | Does |
|---|---|
| `check [--quick] [--hook] [--project <root>]` | all checks; `--quick` = C1, C3, C4, C5, C10 only; `--hook` = exit 0 always, silent when clean or no config, leading ⚠️ line when C3 or C4 FAIL |
| `check --quick --cached` | silent when names hash, ledger mtime and findings match `<stateDir>/quick-cache.json`; C3 and C4 FAIL still print every run |
| `check --staged` | pre-commit: env names in added staged lines (`process.env.NAME`, `$NAME`, `${NAME}`) without a ledger row, exit 1; config found in the repo root or a parent, none = exit 0 |
| `intake NAME [--set k=v ...]` | no `--set`: row template with inferred provider, kind, env, consumers, name proposal, plus open fields; `--set`: writes the row (columnMap = mapped columns only), rewrites the env comment above the key to `# <purpose>, ledger: NAME` (never the key line, exit 2 if it would change), appends `<stateDir>/history.jsonl` |
| `check --all [--hook]` | full check on every root in `<brain>/credentials/projects.json` (`{ version: 1, projects: [{ name, root, config?, owner_agent? }] }`), sequential; one line per project, then totals; root without config = one WARN line, skipped; adds C8; exit 1 on any FAIL, 2 on config error; brain dir = `SECRET_LEDGER_BRAIN_DIR` or `~/.claude/brain`. Weekly reassess runs it |
| brain files (written by `check --all`) | `credentials/index.md` regenerated (By provider account, By project, Shared keys, Expiring in 60 days; env badges 🟥 PROD 🟧 OPS 🟩 TEST 🟦 DEV ⬜ LOCAL; names and accounts only), `credentials/weekly-YYYY-MM-DD.md` (per project FAIL/WARN counts by check id plus FAIL lines, same day rerun overwrites), `credentials/history.jsonl` appended from each `<stateDir>/history.jsonl`, deduplicated by event `id` (sha12 of ts + event + name + project) |
| `scan [--project <root>]` | consumers per env name (code refs) plus doc mentions |
| `lint-env [--project <root>]` | env comment rules (C9), file mode and stale copies (C10), banner label vs name (C14) |
| `lint-env --fix --backup-dir <dir> [--apply]` | D4 comment rewrite: refused without `--backup-dir`; default dry run prints the comment diff only (key lines as `NAME=<value>`, aborts exit 3 if a line looks like a value); `--apply` writes a mode 600 backup first, then a post write guard (sorted names + sha256 of the name=value set) restores the backup and exits 3 on any mismatch; then `scripts/git-hooks/lib-protect.sh mirror_env` if present and a history `env_comments_rewritten` event |
| `selftest` | inline fixtures; file cases in a temp dir, removed after |

Planned, print `not built yet` and exit 2: `verify`, `rotate`, `retire`, `rename`, `index`, `history`, and flag `--write`. `rotate` and `retire` reuse the `--fix` backup then apply path (P6).

## 4. Checks

| ID | Check | Level |
|---|---|---|
| C1 | env name has no ledger row | FAIL |
| C2 | ledger row has no env name, not retired | WARN |
| C3 | account empty or `unknown` | FAIL |
| C4 | expires unknown, past, or within 7 days | FAIL |
| C5 | expires within 30 days | WARN |
| C6 | name fails the naming regex, proposal printed | WARN |
| C7 | active row with 0 consumers | WARN |
| C8 | `check --all`, 2+ projects: name in more than one project, no row sets `source` or `shared_with` | FAIL |
| C9 | env comment: more than one line, a date, a URL or "expires"; loose comments; key before first banner | FAIL |
| C10 | env file mode not 600, or a backup copy in a secret dir | FAIL |
| C12 | last verified over 90 days ago | WARN |
| C13 | token shaped literal in a scanned non env file (file and line only) | FAIL |
| C14 | env label differs between name segment, banner and ledger row | FAIL |
| C15 | PROD row without copies or rotation steps | FAIL |

C11 (copy digest) comes with the store layer.

## 5. Exit codes

| Code | Meaning |
|---|---|
| 0 | clean or WARN only |
| 1 | at least one FAIL |
| 2 | usage or config error |
| 3 | refused: output matched a token shape and was redacted |

## 6. Safety
- Env files are parsed for names only; the value side is never extracted.
- Every printed line passes one `redact()` built from the pre-commit token shapes plus `redactExtra`. A match prints `[redacted]` and forces exit 3.
- Output marks: `⚠️ FAIL`, `△ WARN`, `✓ clean`, no color codes.

## 7. Public port
Scan with the skill's own allowlist (also auto-loaded from the folder): `node ~/.claude/skills/public-scrub/scripts/scrub.mjs ~/.claude/skills/secret-ledger --allow ~/.claude/skills/secret-ledger/.scrub-allow.txt`. The allowlist holds the documented `.secrets/` and `.env.api.local` default paths and the `verified:` frontmatter line only.
