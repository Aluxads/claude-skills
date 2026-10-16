---
name: image-process
description: One page image from a prompts doc slot to webp srcset, asset log row and paste ready snippet, with a hard render review stop before processing.
metadata:
  trigger: /image-process, image chain, process image, generate page image
---

# Image process

Run from the project root. Script: `~/.claude/skills/image-process/scripts/image-chain.mjs`. Generation runs through a shell command you provide in `IMAGE_GEN_CMD`. Processing uses `ffmpeg` (libwebp, metadata stripped) and `ffprobe`.

## Setup
1. Install `ffmpeg` (includes `ffprobe`).
2. Set the generation command. The script exports `PROMPT` (style block plus slot text), `OUT` (PNG path), `PROMPT_FILE` and `SLOT` before it runs:
   ```
   export IMAGE_GEN_CMD='openai images generate --prompt "$PROMPT" --out "$OUT"'
   ```
   Unset = the script stops with a clear error. `--skip-generate <png>` needs no command.
3. Write a prompts doc, default location `docs/image-prompts-<page>.md`:
   ```
   ## Shared style block
   Flat studio photo, soft daylight, light grey backdrop, no text, no logos.

   ## 1. Hero
   A standing desk with a laptop and a notebook, seen from the front.
   ```

## When to use
- A page has an image slot and a prompts doc holds its final prompt as a `## N.` section under a `## Shared style block`.
- A reviewed PNG already exists and only needs the processing half (`--skip-generate <png>`).
- Not for: writing prompts, wiring the image into a page.

## The two step run
1. Generate, then stop:
   ```
   node ~/.claude/skills/image-process/scripts/image-chain.mjs --prompts docs/image-prompts-<page>.md --slot 1 --brand acme --basename acme-standing-desk-front --element hero --alt "Standing desk: laptop and notebook on a clean surface"
   ```
   Preflight runs, the PNG lands in `tmp/img_processing/<basename>.png`, the script prints `REVIEW: <path>` and exits 0.
2. Open the PNG and review it yourself. Reject: subject cut by the frame, stray letters, logos, dark background, missing subject. One retry with a tightened prompt, then stop and report.
3. Approved: rerun the same command with `--approve`. Generation is skipped because the PNG exists. The chain writes the webp set to `public/images/`, checks each file against the byte limit, moves the source to `tmp/img_processing/done/`, appends a row to `docs/image-assets.md` (`wired: no`) and prints the srcset object and the final alt.

Exit codes: 0 ok or stopped for review, 1 preflight or processing fail, 2 generation quota or limit (message printed verbatim; park and retry later).

## Flags
| flag | meaning |
|---|---|
| `--prompts <doc>` | prompts doc, project relative |
| `--slot <N>` | `## N.` section in the doc |
| `--basename <name>` | must match `^<brand>-[a-z0-9-]+$` |
| `--brand <slug>` | basename prefix, default `site` |
| `--element hero\|inline\|card\|og` | size set 420/760/1120, 420/680/900, 320/480/640, 1200 |
| `--alt "<text>"` | alt text without the suffix |
| `--alt-suffix <text>` | appended as ` \| <text>`, default none |
| `--out-dir <dir>` | webp output, default `public/images` |
| `--work-dir <dir>` | PNG drop zone, default `tmp/img_processing` |
| `--asset-log <file>` | Markdown log, default `docs/image-assets.md` |
| `--max-kb <N>` | byte limit per webp, default 120 |
| `--quality <N>` | webp quality, default 80 |
| `--style-ref <doc>` | optional: shared style block must equal the one in this doc |
| `--allow-nod` | with `--style-ref`, accept the reference plus appended sentences |
| `--dry-run` | preflight plus the generation settings, nothing generated |
| `--skip-generate <png>` | use an existing PNG (copied to the drop zone name) |
| `--approve` | continue past the review stop; needs the PNG present |
| `--help` | usage |

## What it never does
- Wire an image into a page or edit source files.
- Commit, push or deploy.
- Invent or rewrite prompts; a missing slot section is a preflight fail.
- Judge its own render: the review stop is unconditional without `--approve`.

## Lessons
None yet. Add one dated line per lesson: `- YYYY-MM-DD: <lesson>`.
