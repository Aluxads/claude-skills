#!/usr/bin/env node
// image-chain.mjs: one page image from a prompts doc slot to webp srcset, asset log row and paste snippet.
// Generation runs through the shell command in IMAGE_GEN_CMD. Resizing uses ffmpeg (libwebp).
// Exit 0 ok (or stopped for review), 1 preflight or processing fail, 2 generation limit.
import { execFileSync, spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync, renameSync, appendFileSync, copyFileSync } from "fs";
import { join, resolve, dirname } from "path";

const argv = process.argv.slice(2);
const get = (f, d = null) => { const i = argv.indexOf(f); return i !== -1 ? argv[i + 1] : d; };
const has = (f) => argv.includes(f);

const HELP = `image-chain.mjs: prompts doc slot -> PNG -> review stop -> webp srcset, asset log row, paste snippet.
Run from the project root.

usage: node image-chain.mjs --prompts <doc> --slot <N> --basename <brand-keyword-descriptor> --element <hero|inline|card|og> --alt "<alt>" [options]

options:
  --brand <slug>          basename prefix, default "site" (basename must start with "<brand>-")
  --alt-suffix <text>     appended to the alt as " | <text>", default none
  --out-dir <dir>         webp output dir, default public/images
  --work-dir <dir>        PNG drop zone, default tmp/img_processing (done/ inside)
  --asset-log <file>      Markdown log that gets one row per image, default docs/image-assets.md
  --max-kb <N>            byte limit per webp, default 120
  --quality <N>           webp quality 1-100, default 80
  --style-ref <doc>       optional prompts doc whose shared style block must match the prompts doc
  --allow-nod             accept a style block that is the reference verbatim plus appended sentences
  --dry-run               preflight plus the generation command, nothing generated
  --skip-generate <png>   use an existing PNG (copied to the drop zone name)
  --approve               continue past the review stop; needs the PNG present
  --help                  this text

prompts doc format: a "## Shared style block" heading followed by one paragraph, then one "## N. <title>" section per slot.

generation: set IMAGE_GEN_CMD to a shell command template. The script exports PROMPT (slot text with the
style block prepended), OUT (PNG path), PROMPT_FILE, SLOT before running it. Example:
  export IMAGE_GEN_CMD='openai images generate --prompt "$PROMPT" --out "$OUT"'

requires ffmpeg and ffprobe on PATH for the processing half.
exit codes: 0 ok or stopped for review, 1 preflight or processing fail, 2 generation quota or limit.`;

if (has("--help") || has("-h")) { console.log(HELP); process.exit(0); }

const ROOT = process.cwd();
const prompts = get("--prompts"), slot = get("--slot"), name = get("--basename");
const element = get("--element"), alt = get("--alt"), skipGen = get("--skip-generate");
const brand = get("--brand", "site"), altSuffix = get("--alt-suffix", "");
const OUT_DIR = resolve(ROOT, get("--out-dir", "public/images"));
const DROP = resolve(ROOT, get("--work-dir", "tmp/img_processing"));
const ASSETS = resolve(ROOT, get("--asset-log", "docs/image-assets.md"));
const limitKB = Number(get("--max-kb", "120")), quality = Number(get("--quality", "80"));
const styleRef = get("--style-ref");
const dry = has("--dry-run"), approve = has("--approve"), allowNod = has("--allow-nod");

const SETS = { hero: [420, 760, 1120], inline: [420, 680, 900], card: [320, 480, 640], og: [1200] };
const SIZES = {
  hero: { src: 760, sizes: "(min-width: 1120px) 45vw, 100vw" },
  inline: { src: 680, sizes: "(min-width: 900px) 45vw, 100vw" },
  card: { src: 480, sizes: "(min-width: 900px) 420px, 100vw" },
};

const fail = (msg, code = 1) => { console.error(`FAIL: ${msg}`); process.exit(code); };
const norm = (s) => s.replace(/\s+/g, " ").trim();
const rel = (p) => p.replace(ROOT + "/", "");

// 1. Preflight
if (!prompts || !slot || !name || !element || !alt) {
  fail("missing required flags, run with --help for usage");
}
const docPath = resolve(ROOT, prompts);
if (!existsSync(docPath)) fail(`prompts doc not found: ${prompts}`);
if (!SETS[element]) fail(`element must be one of ${Object.keys(SETS).join(", ")}`);
if (!/^[a-z0-9-]+$/.test(brand)) fail(`brand must match ^[a-z0-9-]+$: ${brand}`);
if (!new RegExp(`^${brand}-[a-z0-9-]+$`).test(name)) fail(`basename must match ^${brand}-[a-z0-9-]+$: ${name}`);
if (altSuffix && alt.endsWith(`| ${altSuffix}`)) fail(`alt already ends in | ${altSuffix}, pass it without the suffix`);
if (!(limitKB > 0) || !(quality >= 1 && quality <= 100)) fail("--max-kb must be above 0 and --quality 1 to 100");

const styleOf = (text) => (text.match(/## Shared style block[^\n]*\n(.+?)(?:\n\n|$)/s) || [])[1];
const doc = readFileSync(docPath, "utf8");
const block = styleOf(doc);
if (!block) fail(`no "## Shared style block" in ${prompts}`);
const slotM = doc.match(new RegExp(`^## ${slot}\\. [^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m"));
if (!slotM) fail(`slot section "## ${slot}." not found in ${prompts}`);
const slotText = slotM[1].trim();

if (styleRef) {
  const refPath = resolve(ROOT, styleRef);
  if (!existsSync(refPath)) fail(`--style-ref not found: ${styleRef}`);
  const refBlock = styleOf(readFileSync(refPath, "utf8"));
  if (!refBlock) fail(`${styleRef} has no shared style block`);
  const a = norm(block), r = norm(refBlock);
  if (a !== r) {
    const extra = a.startsWith(r) ? a.slice(r.length).trim() : null;
    if (extra && allowNod) {
      console.log(`style block: reference ${styleRef} verbatim + extension (--allow-nod): "${extra}"`);
    } else {
      const as = a.split(/(?<=\.)\s+/), rs = r.split(/(?<=\.)\s+/);
      console.error(`style block differs from reference ${styleRef}:`);
      rs.filter((s) => !as.includes(s)).forEach((s) => console.error(`  - ${s}`));
      as.filter((s) => !rs.includes(s)).forEach((s) => console.error(`  + ${s}`));
      if (extra) console.error("  (doc = reference + extra sentences; pass --allow-nod if the extra is intended)");
      fail("style block mismatch");
    }
  } else console.log(`style block: identical to reference ${styleRef}`);
}
console.log(`byte limit: ${limitKB} KB per webp, quality ${quality}`);
console.log(`preflight PASS: ${prompts} slot ${slot}, ${name}, ${element} ${SETS[element].join("/")}`);

// 2. Generate
const png = join(DROP, `${name}.png`);
mkdirSync(join(DROP, "done"), { recursive: true });
const promptText = `${block}\n\n${slotText}`;
if (skipGen) {
  const src = resolve(ROOT, skipGen);
  if (!existsSync(src)) fail(`--skip-generate file not found: ${skipGen}`);
  if (src !== png && !dry) copyFileSync(src, png);
  console.log(`generate: skipped, using ${rel(src)}`);
} else if (dry) {
  const cmd = process.env.IMAGE_GEN_CMD;
  console.log(`dry run: IMAGE_GEN_CMD=${cmd ? JSON.stringify(cmd) : "(unset, generation would fail)"}`);
  console.log(`dry run: OUT=${rel(png)} SLOT=${slot} PROMPT=${promptText.length} chars`);
} else if (!existsSync(png) && !approve) {
  const cmd = process.env.IMAGE_GEN_CMD;
  if (!cmd) fail("IMAGE_GEN_CMD is not set. Set it to a shell command that reads $PROMPT and writes the PNG to $OUT, e.g. export IMAGE_GEN_CMD='openai images generate --prompt \"$PROMPT\" --out \"$OUT\"'");
  const promptFile = join(DROP, `${name}.prompt.txt`);
  writeFileSafe(promptFile, promptText);
  const g = spawnSync("bash", ["-c", cmd], {
    cwd: ROOT, encoding: "utf8",
    env: { ...process.env, PROMPT: promptText, OUT: png, PROMPT_FILE: promptFile, SLOT: String(slot) },
  });
  const out = `${g.stdout || ""}${g.stderr || ""}`.trim();
  if (g.status !== 0) {
    console.error(out);
    if (/quota|rate.?limit|usage limit|limit reached|too many requests|\b429\b/i.test(out)) process.exit(2);
    fail("generation failed");
  }
  if (out) console.log(out);
  if (!existsSync(png)) fail(`IMAGE_GEN_CMD finished but wrote no file at ${rel(png)}`);
} else if (existsSync(png)) console.log(`generate: skipped, ${rel(png)} exists`);
if (dry) { console.log("dry run: stop before review"); process.exit(0); }

function writeFileSafe(p, text) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

// 3. Render review stop
if (!approve) {
  console.log(`\nREVIEW: ${rel(png)}`);
  console.log("Reject on: subject cut by the frame, stray letters, logos, dark background, missing subject element.");
  console.log("Approved: rerun the same command with --approve (generation is skipped when the PNG exists).");
  process.exit(0);
}
if (!existsSync(png)) fail(`no PNG to process at ${rel(png)}`);

// 4. Process (ffmpeg, metadata stripped) and verify
mkdirSync(OUT_DIR, { recursive: true });
for (const w of SETS[element]) {
  const f = join(OUT_DIR, `${name}-${w}.webp`);
  const p = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", png, "-vf", `scale=${w}:-2`, "-map_metadata", "-1", "-c:v", "libwebp", "-quality", String(quality), f], { encoding: "utf8" });
  if (p.error) fail(`ffmpeg not runnable: ${p.error.message}`);
  if (p.status !== 0) { console.error(p.stderr); fail("ffmpeg failed"); }
}
let over = 0;
for (const w of SETS[element]) {
  const f = join(OUT_DIR, `${name}-${w}.webp`);
  if (!existsSync(f)) fail(`missing ${rel(f)}`);
  const kb = statSync(f).size / 1024;
  console.log(`  ${rel(f)} ${kb.toFixed(1)} KB ${kb > limitKB ? `OVER ${limitKB} KB` : "ok"}`);
  if (kb > limitKB) over++;
}
if (over) fail(`${over} webp over ${limitKB} KB: lower --quality or raise --max-kb, source left in place`);
const done = join(DROP, "done", `${name}.png`);
renameSync(png, done);

// 5. Asset log row
const fullAlt = altSuffix ? `${alt} | ${altSuffix}` : alt;
const today = new Date().toISOString().slice(0, 10);
mkdirSync(dirname(ASSETS), { recursive: true });
appendFileSync(ASSETS, `\n### ${today}, ${name} (prompts ${prompts} slot ${slot})\n- \`${name}-{${SETS[element].join(",")}}.webp\` (${element}), alt "${fullAlt}", source PNG ${rel(done)}. wired: no.\n`);
console.log(`asset log row appended: ${rel(ASSETS)}`);

// 6. Paste snippet
const publicPath = "/" + rel(OUT_DIR).replace(/^public\//, "");
const big = join(OUT_DIR, `${name}-${SETS[element].at(-1)}.webp`);
const dims = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", big], { encoding: "utf8" }).trim().split(",");
console.log("\nSNIPPET:");
if (element === "og") {
  console.log(`og image: ${publicPath}/${name}-1200.webp (${dims.join("x")}); some networks need a jpg, convert separately`);
} else {
  const s = SIZES[element];
  console.log(`{\n  src: "${publicPath}/${name}-${s.src}.webp",\n  srcset: "${SETS[element].map((w) => `${publicPath}/${name}-${w}.webp ${w}w`).join(", ")}",\n  sizes: "${s.sizes}",\n  width: ${dims[0]},\n  height: ${dims[1]},\n  alt: "${fullAlt}",\n}`);
}
console.log(`ALT: ${fullAlt}`);
