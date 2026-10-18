#!/usr/bin/env node
// secret-ledger: names only checks of env files against a markdown ledger. Never prints a value.
// Usage: node ledger.mjs <check|scan|lint-env|intake|selftest> [flags], see USAGE.
// Exit: 0 clean or WARN only, 1 FAIL, 2 usage or config error, 3 refused (redact tripped).
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { COLUMNS, REQUIRED, ENVS, KINDS, WARN_DAYS, FAIL_DAYS, VERIFY_MAX_DAYS } from "./lib/defaults.mjs";
import { redact, tripped, addPatterns, rememberValue, resetRedact, hasToken } from "./lib/redact.mjs";
import { LedgerError, loadConfig, validateConfig, expandHome, CONFIG_FILE } from "./lib/config.mjs";
import { parseEnv, setKeyComment, commentReasons } from "./lib/envparse.mjs";
import { planFix, envDigest, maskComment, looksLikeValue, keyLines } from "./lib/envfix.mjs";
import { parseLedger, splitRow, upsertRow } from "./lib/ledger.mjs";
import { scanProject, extractRefs, kindOf } from "./lib/scan.mjs";
import { propose, envSegment, nameParts } from "./lib/naming.mjs";
import { withId, readJsonl, newEvents } from "./lib/history.mjs";
import { nameRecords, sharedNames, renderIndex, renderWeekly } from "./lib/index.mjs";

const SELF = fileURLToPath(import.meta.url);
const COMMANDS = {
  check: ["--quick", "--hook", "--cached", "--staged", "--project", "--all"],
  scan: ["--project"],
  "lint-env": ["--project", "--fix", "--backup-dir", "--apply"],
  intake: ["--project", "--set"],
  selftest: [],
};
const LATER_COMMANDS = ["verify", "rotate", "retire", "rename", "index", "history"];
const LATER_FLAGS = ["--write", "--since", "--name"];
const USAGE = "usage: ledger.mjs check [--quick [--cached]] [--staged] [--hook] [--project <root>] | check --all [--hook] | scan | lint-env [--fix --backup-dir <dir> [--apply]] | intake NAME [--set k=v ...] | selftest";
const INTAKE_CMD = "node ~/.claude/skills/secret-ledger/scripts/ledger.mjs intake";
const MARK = { FAIL: "⚠️ FAIL", WARN: "△ WARN" };

const makeOut = (write) => (s = "") => write(redact(s) + "\n");
let out = makeOut((s) => process.stdout.write(s));
const err = makeOut((s) => process.stderr.write(s));

function finish(code, hook = false) {
  if (tripped()) code = 3;
  process.exit(hook ? 0 : code);
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") throw new LedgerError(USAGE);
  if (LATER_COMMANDS.includes(cmd)) throw new LedgerError(`${cmd}: not built yet`);
  if (!COMMANDS[cmd]) throw new LedgerError(`unknown command: ${cmd}`);
  const a = { cmd, project: process.cwd(), quick: false, hook: false, cached: false, staged: false, all: false, projectSet: false, fix: false, apply: false, backupDir: null, set: [], name: null };
  // --hook is read first so a usage error inside a hook still exits 0
  a.hook = cmd === "check" && rest.includes("--hook");
  for (let i = 0; i < rest.length; i++) {
    const f = rest[i];
    if (cmd === "intake" && !f.startsWith("--") && a.name === null) {
      a.name = f;
      continue;
    }
    if (LATER_FLAGS.includes(f)) throw new LedgerError(`${f}: not built yet`);
    if (!COMMANDS[cmd].includes(f)) throw new LedgerError(`unknown flag for ${cmd}: ${f}`);
    if (f === "--project" || f === "--set" || f === "--backup-dir") {
      if (rest[i + 1] === undefined) throw new LedgerError(`${f} needs a value`);
      if (f === "--project") {
        a.project = path.resolve(expandHome(rest[++i]));
        a.projectSet = true;
      }
      else if (f === "--backup-dir") a.backupDir = path.resolve(expandHome(rest[++i]));
      else a.set.push(rest[++i]);
    } else a[f.slice(2)] = true;
  }
  if (a.cached && !a.quick) throw new LedgerError("--cached needs --quick");
  if ((a.apply || a.backupDir) && !a.fix) throw new LedgerError("--apply and --backup-dir need --fix");
  if (a.fix && !a.backupDir) throw new LedgerError("--fix refused: --backup-dir <dir> is required");
  if (a.staged && a.quick) throw new LedgerError("--staged and --quick are separate modes");
  if (a.all && (a.quick || a.staged || a.projectSet)) throw new LedgerError("--all runs the full check on every projects.json root, no --quick, --staged or --project");
  if (cmd === "intake" && !/^[A-Z][A-Z0-9_]+$/.test(a.name || "")) throw new LedgerError("intake needs an env NAME (A-Z, 0-9, _)");
  return a;
}

// ---------- loading (names only) ----------

function loadEnvs(root, cfg) {
  return cfg.envFiles.map((rel) => {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) return { rel, missing: true };
    const parsed = parseEnv(fs.readFileSync(p, "utf8"));
    return { rel, parsed, mode: fs.statSync(p).mode & 0o777 };
  });
}

function findStale(root, cfg) {
  const found = [];
  const visit = (rel, depth) => {
    let ents;
    try {
      ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory() && depth < 3) visit(r, depth + 1);
      else if (e.isFile() && (/\.bak/i.test(e.name) || /\.old$/i.test(e.name))) found.push(r);
    }
  };
  cfg.secretDirs.forEach((d) => visit(d.replace(/\/$/, ""), 0));
  return found;
}

function loadLedger(root, cfg) {
  const p = path.join(root, cfg.ledger);
  if (!fs.existsSync(p)) throw new LedgerError(`ledger not found: ${cfg.ledger}`);
  return parseLedger(fs.readFileSync(p, "utf8"), cfg.columnMap);
}

// ---------- checks ----------

const DAY = 864e5;
const todayUTC = () => {
  const t = new Date();
  return Date.UTC(t.getFullYear(), t.getMonth(), t.getDate());
};
const isoDays = (s, today) => {
  const m = (s || "").match(/^(\d{4}-\d{2}-\d{2})\b/);
  return m ? Math.round((Date.parse(`${m[1]}T00:00:00Z`) - today) / DAY) : null;
};

function envFindings(envs, stale, add) {
  for (const e of envs) {
    if (e.missing) {
      add("WARN", "C10", e.rel, "env file listed in config not found");
      continue;
    }
    if (e.mode !== 0o600) add("FAIL", "C10", e.rel, `file mode ${e.mode.toString(8)}, want 600`);
  }
  for (const s of stale) add("FAIL", "C10", s, "stale copy inside a secret dir");
}

function commentFindings(envs, add) {
  for (const e of envs) {
    if (e.missing) continue;
    const p = e.parsed;
    for (const rec of p.keys.values()) {
      if (rec.reasons.length) add("FAIL", "C9", rec.name, `${e.rel}:${rec.commentLines.join(",")} comment breaks D4 (${rec.reasons.join(", ")})`);
    }
    if (p.loose.length) add("FAIL", "C9", e.rel, `${p.loose.length} comment line(s) not attached to a key, lines ${p.loose.join(",")}`);
    for (const b of p.beforeBanner) add("FAIL", "C9", b.name, `${e.rel}:${b.line} key before the first group banner`);
    for (const d of p.duplicates) add("WARN", "ENV", d.name, `${e.rel}:${d.line} duplicate (first at line ${d.first})`);
    if (p.malformed.length) add("WARN", "ENV", e.rel, `malformed line(s) ${p.malformed.join(",")}`);
  }
}

const envNameMap = (envs) => {
  const m = new Map();
  for (const e of envs) if (!e.missing) for (const [n, rec] of e.parsed.keys) if (!m.has(n)) m.set(n, { file: e.rel, rec });
  return m;
};

function labelFindings(envNames, rowEnv, add) {
  for (const [n, { rec }] of envNames) {
    const labels = { name: envSegment(n), banner: rec.bannerEnv, ledger: rowEnv(n) };
    const set = new Set(Object.values(labels).filter(Boolean));
    if (set.size > 1) {
      const txt = Object.entries(labels).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(", ");
      add("FAIL", "C14", n, `env_mismatch: ${txt}`);
    }
  }
}

export function runChecks(ctx, { quick = false, today = todayUTC() } = {}) {
  const F = [];
  const add = (level, id, subject, msg, tag) => F.push({ level, id, subject, msg, tag });
  const { cfg, envs, stale, ledger, scan } = ctx;
  const map = ledger.mode === "map";
  const tag = map ? "migration" : undefined;
  const has = (col) => ledger.idx[col] !== undefined;
  const val = (r, col) => (r && has(col) ? r.cells[col] : "").trim();
  const retired = (r) => (map ? /retired|deleted|revoked/i.test(val(r, "status")) : /^retired$/i.test(val(r, "status")));
  const active = (r) => (map ? !retired(r) : /^active$/i.test(val(r, "status")));
  const envNames = envNameMap(envs);
  const rows = new Map();
  for (const r of ledger.rows) for (const n of r.names) if (!rows.has(n)) rows.set(n, r);

  for (const n of envNames.keys()) if (!rows.has(n)) add("FAIL", "C1", n, "env name has no ledger row");

  for (const [n, r] of rows) {
    if (retired(r)) continue;
    if (has("account")) {
      const a = val(r, "account");
      if (!a || /^unknown$/i.test(a)) add("FAIL", "C3", n, "account empty or unknown", tag);
    }
    if (has("expires")) {
      const e = val(r, "expires");
      const d = isoDays(e, today);
      if (!e || /^unknown$/i.test(e)) add("FAIL", "C4", n, "expires empty or unknown", tag);
      else if (d !== null && d < 0) add("FAIL", "C4", n, `expired ${-d} day(s) ago`, tag);
      else if (d !== null && d <= FAIL_DAYS) add("FAIL", "C4", n, `expires in ${d} day(s)`, tag);
      else if (d !== null && d <= WARN_DAYS) add("WARN", "C5", n, `expires in ${d} day(s)`, tag);
      else if (d === null && !/^none\b/i.test(e)) add("FAIL", "C4", n, "expires is not an ISO date, none (source) or unknown", tag);
    }
  }
  envFindings(envs, stale, add);
  if (quick) return F;

  for (const [n, r] of rows) if (!envNames.has(n) && !retired(r)) add("WARN", "C2", n, "orphan: ledger row has no env name");

  labelFindings(envNames, (n) => (has("env") ? val(rows.get(n), "env").toUpperCase() : ""), add);

  for (const [n, r] of rows) {
    if (retired(r) || !has("env") || val(r, "env").toUpperCase() !== "PROD") continue;
    const miss = ["copies", "rotation_steps"].filter((c) => has(c) && !val(r, c));
    if (miss.length) add("FAIL", "C15", n, `PROD key without ${miss.join(" and ")}`, tag);
  }

  const nameRe = new RegExp(cfg.namingRegex);
  for (const n of envNames.keys()) {
    if (nameRe.test(n)) continue;
    const r = rows.get(n);
    add("WARN", "C6", n, `name fails naming rule, proposal ${propose(n, cfg.prefix, { env: val(r, "env"), provider: val(r, "provider") })}`);
  }

  if (scan) {
    for (const n of envNames.keys()) {
      const r = rows.get(n);
      if (r && active(r) && !(scan.consumers.get(n)?.size)) add("WARN", "C7", n, `unused: 0 consumers (${scan.mentions.get(n)?.size || 0} doc mentions)`);
    }
    for (const l of scan.literals) add("FAIL", "C13", `${l.file}:${l.line}`, "literal token shape in a non env file");
    for (const e of scan.errors) add("WARN", "SCAN", e.file, e.error);
  }

  commentFindings(envs, add);

  if (has("last_verified")) {
    for (const [n, r] of rows) {
      const d = isoDays(val(r, "last_verified"), today);
      if (d !== null && -d > VERIFY_MAX_DAYS) add("WARN", "C12", n, `last verified ${-d} days ago`);
    }
  }

  if (map) {
    const open = REQUIRED.filter((c) => !has(c));
    add("WARN", "MIG", cfg.ledger, `columnMap: ${rows.size} names read, open fields (unmapped): ${open.join(", ")}`, tag);
    for (const [n, r] of rows) {
      const empty = REQUIRED.filter((c) => has(c) && !val(r, c));
      if (empty.length) add("WARN", "MIG", n, `open fields: ${empty.join(", ")}`, tag);
    }
  }
  return F;
}

const exitFor = (F) => (F.some((f) => f.level === "FAIL") ? 1 : 0);

function report(F, title) {
  const sorted = [...F].sort((a, b) => (a.level === b.level ? 0 : a.level === "FAIL" ? -1 : 1));
  for (const f of sorted) out(`${MARK[f.level]} ${f.id} ${f.subject}: ${f.msg}${f.tag ? ` [${f.tag}]` : ""}`);
  const fails = F.filter((f) => f.level === "FAIL").length;
  const counts = {};
  for (const f of F) counts[`${f.id} ${f.level}`] = (counts[`${f.id} ${f.level}`] || 0) + 1;
  if (!F.length) out(`✓ clean ${title}`);
  else {
    out(`${title}: FAIL ${fails}, WARN ${F.length - fails}`);
    out(`by check: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  }
}

// ---------- commands ----------

function project(a) {
  const cfg = loadConfig(a.project);
  if (!cfg) {
    if (a.hook) return null;
    throw new LedgerError(`no .secret-ledger.json in ${a.project}`);
  }
  addPatterns(cfg.redactExtra);
  return cfg;
}

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const ALWAYS = (f) => f.level === "FAIL" && (f.id === "C3" || f.id === "C4");
const alwaysLead = (F) => {
  const n = F.filter(ALWAYS).length;
  if (n) out(`⚠️ secret-ledger: ${n} key(s) expired, expiring or without an owner identity (C3, C4)`);
};

// Quick cache: names hash + ledger mtime + hash of the last printed findings. Unchanged = silent,
// except C3 and C4 FAIL lines, which print on every run.
function quickCached(a, cfg, envs, F) {
  const names = sha([...envNameMap(envs).keys()].sort().join("\n")).slice(0, 12);
  let mtime = 0;
  try {
    mtime = fs.statSync(path.join(a.project, cfg.ledger)).mtimeMs;
  } catch {}
  const findings = sha(F.map((f) => `${f.level} ${f.id} ${f.subject} ${f.msg}`).sort().join("\n")).slice(0, 12);
  const dir = path.join(a.project, cfg.stateDir);
  const file = path.join(dir, "quick-cache.json");
  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  const same = prev && prev.names === names && prev.ledgerMtime === mtime && prev.findings === findings;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ names, ledgerMtime: mtime, findings, at: new Date().toISOString() }) + "\n");
  } catch {}
  return a.cached && same;
}

function cmdCheck(a) {
  if (a.all) return cmdAll(a);
  if (a.staged) return cmdStaged(a);
  const cfg = project(a);
  if (!cfg) return 0;
  const envs = loadEnvs(a.project, cfg);
  const ledger = loadLedger(a.project, cfg);
  const scan = a.quick ? null : scanProject(a.project, cfg, new Set(envNameMap(envs).keys()));
  const F = runChecks({ cfg, envs, stale: findStale(a.project, cfg), ledger, scan }, { quick: a.quick });
  const title = `secret-ledger check${a.quick ? " --quick" : ""} ${cfg.project}`;
  if (a.quick && quickCached(a, cfg, envs, F)) {
    const keep = F.filter(ALWAYS);
    if (!keep.length) return 0;
    alwaysLead(keep);
    report(keep, title);
    return exitFor(F);
  }
  if (a.hook && !F.length) return 0;
  if (a.hook) alwaysLead(F);
  report(F, title);
  if (!a.quick) out("not in a single project check: C8 cross project consumers (runs in check --all), C11 copy sha12 (store verify)");
  return exitFor(F);
}

// ---------- check --all (brain layer) ----------

export const brainDir = () => path.resolve(expandHome(process.env.SECRET_LEDGER_BRAIN_DIR || "~/.claude/brain"));
const PROJECT_KEYS = ["name", "root", "config", "owner_agent"];

function loadProjects(dir) {
  const file = path.join(dir, "credentials", "projects.json");
  if (!fs.existsSync(file)) throw new LedgerError(`projects.json not found: ${file}`);
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new LedgerError("projects.json is not valid JSON");
  }
  if (!obj || obj.version !== 1 || !Array.isArray(obj.projects)) throw new LedgerError("projects.json: want { \"version\": 1, \"projects\": [...] }");
  const seen = new Set();
  return obj.projects.map((p, i) => {
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new LedgerError(`projects.json: projects[${i}] is not an object`);
    const unknown = Object.keys(p).filter((k) => !PROJECT_KEYS.includes(k));
    if (unknown.length) throw new LedgerError(`projects.json: projects[${i}] unknown key(s): ${unknown.join(", ")}`);
    if (typeof p.name !== "string" || !p.name || typeof p.root !== "string" || !p.root) throw new LedgerError(`projects.json: projects[${i}] needs name and root strings`);
    if (p.config !== undefined && (typeof p.config !== "string" || !p.config)) throw new LedgerError(`projects.json: projects[${i}] config must be a string`);
    if (seen.has(p.name)) throw new LedgerError(`projects.json: duplicate project ${p.name}`);
    seen.add(p.name);
    return { name: p.name, root: path.resolve(expandHome(p.root)), config: p.config || CONFIG_FILE };
  });
}

function checkProject(p, today) {
  const cfg = loadConfig(p.root, p.config);
  if (!cfg) return { name: p.name, status: "skipped", reason: `no ${p.config} in ${p.root}` };
  addPatterns(cfg.redactExtra);
  const envs = loadEnvs(p.root, cfg);
  const ledger = loadLedger(p.root, cfg);
  const envNames = new Set(envNameMap(envs).keys());
  const scan = scanProject(p.root, cfg, envNames);
  const F = runChecks({ cfg, envs, stale: findStale(p.root, cfg), ledger, scan }, { today });
  return { name: p.name, status: "ok", root: p.root, cfg, F, records: nameRecords(p.name, ledger, envNames, cfg.prefix) };
}

// C8: a name in 2+ loaded projects where no row sets source or shared_with.
export function crossFindings(loaded) {
  if (loaded.length < 2) return;
  const by = new Map(loaded.map((p) => [p.name, p]));
  for (const s of sharedNames(loaded.flatMap((p) => p.records))) {
    if (s.linked || s.projects.length < 2) continue;
    for (const name of s.projects) {
      const others = s.projects.filter((x) => x !== name).join(", ");
      by.get(name).F.push({ level: "FAIL", id: "C8", subject: s.name, msg: `consumer in project ${others}, row has no source / shared_with link` });
    }
  }
}

const writeReport = (file, text) => fs.writeFileSync(file, text.split("\n").map((l) => redact(l)).join("\n"));

function cmdAll(a) {
  const t0 = Date.now();
  const dir = brainDir();
  const list = loadProjects(dir);
  const today = todayUTC();
  const res = list.map((p) => {
    try {
      return checkProject(p, today);
    } catch (e) {
      return { name: p.name, status: "error", reason: e instanceof LedgerError ? e.message : "internal error while checking" };
    }
  });
  const loaded = res.filter((r) => r.status === "ok");
  crossFindings(loaded);
  let fail = 0;
  let warn = 0;
  for (const r of res) {
    if (r.status === "skipped") out(`${MARK.WARN} ${r.name}: ${r.reason}, skipped`);
    else if (r.status === "error") out(`${MARK.FAIL} ${r.name}: config error: ${r.reason}`);
    else {
      const f = r.F.filter((x) => x.level === "FAIL").length;
      const w = r.F.length - f;
      fail += f;
      warn += w;
      out(f ? `${MARK.FAIL} ${r.name}: FAIL ${f}, WARN ${w}` : w ? `${MARK.WARN} ${r.name}: FAIL 0, WARN ${w}` : `✓ clean ${r.name}`);
    }
  }
  const cred = path.join(dir, "credentials");
  fs.mkdirSync(cred, { recursive: true });
  const date = new Date(today).toISOString().slice(0, 10);
  const model = { ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), today, projects: res };
  writeReport(path.join(cred, "index.md"), renderIndex(model));
  writeReport(path.join(cred, `weekly-${date}.md`), renderWeekly(model, date));
  const brainHist = path.join(cred, "history.jsonl");
  const brainEvents = readJsonl(brainHist).events;
  let added = 0;
  let bad = 0;
  for (const r of loaded) {
    const h = readJsonl(path.join(r.root, r.cfg.stateDir, "history.jsonl"));
    bad += h.bad;
    const add = newEvents(h.events, brainEvents, r.cfg.project);
    if (add.length) fs.appendFileSync(brainHist, add.map((e) => redact(JSON.stringify(e))).join("\n") + "\n");
    brainEvents.push(...add);
    added += add.length;
  }
  const errors = res.filter((r) => r.status === "error").length;
  out(`brain ${cred}: index.md, weekly-${date}.md, history.jsonl +${added} event(s)${bad ? `, ${bad} unparsable project history line(s) skipped` : ""}`);
  out(`secret-ledger check --all: ${loaded.length} checked, ${res.length - loaded.length - errors} skipped, ${errors} config error(s), FAIL ${fail}, WARN ${warn}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return errors ? 2 : fail ? 1 : 0;
}

function cmdScan(a) {
  const cfg = project(a);
  const envs = loadEnvs(a.project, cfg);
  const names = [...envNameMap(envs).keys()].sort();
  const s = scanProject(a.project, cfg, new Set(names));
  for (const n of names) {
    const c = [...s.consumers.get(n)].sort();
    out(`${n} consumers=${c.length} mentions=${s.mentions.get(n).size}`);
    c.forEach((p) => out(`  ${p}`));
  }
  const zero = names.filter((n) => !s.consumers.get(n).size).length;
  out(`secret-ledger scan ${cfg.project}: ${names.length} names, ${s.files} files scanned, ${zero} names with 0 consumers, ${s.literals.length} literal token line(s)`);
  return 0;
}

// Pre-commit: env names referenced in added lines of the staged diff must have a ledger row.
// Every TRD section 8 pattern applies through extractRefs on the staged blob (so wrangler [vars],
// .mcp.json env objects and md command blocks keep their context), limited to names on added lines.
// Files scan does not type fall back to the process.env and $NAME patterns on the added lines.
const STAGED_FALLBACK = [/process\.env\.([A-Z][A-Z0-9_]+)/g, /\$\{?([A-Z][A-Z0-9_]{3,})\}?/g];
const stagedSkip = (f) => /(^|\/)\.env(\.|$)/.test(f) || /(^|\/)\.secrets\//.test(f);

export function stagedRefs(diff, blobOf, known) {
  const added = new Map();
  let file = null;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ")) {
      file = l.slice(4).replace(/^b\//, "");
      if (file === "/dev/null" || stagedSkip(file)) file = null;
      else if (!added.has(file)) added.set(file, []);
      continue;
    }
    if (file && l.startsWith("+")) added.get(file).push(l.slice(1));
  }
  const hits = new Map(); // name -> first file
  for (const [f, lines] of added) {
    const text = lines.join("\n");
    const words = new Set(text.match(/[A-Z][A-Z0-9_]+/g) || []);
    const cand = new Set([...known].filter((n) => words.has(n)));
    if (!cand.size) continue;
    const kind = kindOf(f);
    const refs = new Set();
    if (!kind || kind === "text") {
      for (const re of STAGED_FALLBACK) for (const m of text.matchAll(re)) if (cand.has(m[1])) refs.add(m[1]);
    } else {
      const blob = blobOf(f);
      if (blob !== null) extractRefs(f, blob, cand).refs.forEach((n) => refs.add(n));
    }
    for (const n of refs) if (!hits.has(n)) hits.set(n, f);
  }
  return hits;
}

function findConfigRoot(start) {
  for (let d = start; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, CONFIG_FILE))) return d;
    if (path.dirname(d) === d) return null;
  }
}

function cmdStaged(a) {
  const root = findConfigRoot(a.project);
  if (!root) return 0;
  const cfg = project({ ...a, project: root });
  const envs = loadEnvs(root, cfg);
  const known = envNameMap(envs);
  if (!known.size) return 0;
  const g = spawnSync("git", ["-c", "core.quotePath=false", "diff", "--cached", "-U0", "--no-color", "--no-ext-diff", "--diff-filter=d"], { cwd: a.project, encoding: "utf8", maxBuffer: 64 << 20 });
  if (g.status !== 0) throw new LedgerError("git diff --cached failed");
  const blobOf = (f) => {
    const r = spawnSync("git", ["show", `:${f}`], { cwd: a.project, encoding: "utf8", maxBuffer: 64 << 20 });
    return r.status === 0 ? r.stdout : null;
  };
  const hits = stagedRefs(g.stdout, blobOf, new Set(known.keys()));
  if (!hits.size) return 0;
  const ledger = loadLedger(root, cfg);
  const rows = new Set(ledger.rows.flatMap((r) => r.names));
  const missing = [...hits].filter(([n]) => !rows.has(n));
  for (const [n, f] of missing) {
    out(`${MARK.FAIL} C1 ${n}: new env reference in ${f} without a ledger row`);
    out(`  Run: ${INTAKE_CMD} ${n} --project ${root}`);
  }
  if (missing.length) out(`secret-ledger: commit blocked, ${missing.length} name(s) need a ledger row`);
  return missing.length ? 1 : 0;
}

// ---------- intake (D10) ----------

function inferRow(name, root, cfg, envs) {
  const p = nameParts(name, cfg.prefix);
  const env = p.env.startsWith("<") ? "" : p.env;
  const known = envNameMap(envs);
  const inferred = { project: cfg.project, status: "active" };
  if (!p.provider.startsWith("<")) inferred.provider = p.provider.toLowerCase();
  if (!p.kind.startsWith("<")) inferred.kind = p.kind;
  if (env) inferred.env = env;
  const consumers = [...(scanProject(root, cfg, new Set([name])).consumers.get(name) || [])].sort();
  if (consumers.length) inferred.consumers = consumers.join(", ");
  const compliant = new RegExp(cfg.namingRegex).test(name);
  return { inferred, inEnv: known.has(name), envFile: known.get(name)?.file || null, proposal: compliant ? null : propose(name, cfg.prefix, { env, provider: inferred.provider }) };
}

function parseSets(list) {
  const f = {};
  for (const kv of list) {
    const i = kv.indexOf("=");
    const k = i > 0 ? kv.slice(0, i).trim() : "";
    const v = i > 0 ? kv.slice(i + 1).trim() : "";
    if (!COLUMNS.includes(k)) throw new LedgerError(`--set: unknown column ${k || kv}`);
    if (k === "name") throw new LedgerError("--set: name is the positional NAME, use rename to change it");
    if (/[\r\n]/.test(v)) throw new LedgerError(`--set ${k}: one line only`);
    if (hasToken(v)) throw new LedgerError(`--set ${k}: value has a token shape, refused`, 3);
    if (k === "env" && !ENVS.includes(v)) throw new LedgerError(`--set env: one of ${ENVS.join(", ")}`);
    if (k === "kind" && !KINDS.includes(v)) throw new LedgerError(`--set kind: one of ${KINDS.join(", ")}`);
    f[k] = v;
  }
  return f;
}

function cmdIntake(a) {
  const cfg = project(a);
  const root = a.project;
  const name = a.name;
  const envs = loadEnvs(root, cfg);
  const ledgerPath = path.join(root, cfg.ledger);
  if (!fs.existsSync(ledgerPath)) throw new LedgerError(`ledger not found: ${cfg.ledger}`);
  const md = fs.readFileSync(ledgerPath, "utf8");
  const ledger = parseLedger(md, cfg.columnMap);
  const row = ledger.rows.find((r) => r.names.includes(name));
  const inf = inferRow(name, root, cfg, envs);
  const writable = COLUMNS.filter((c) => ledger.idx[c] !== undefined);

  if (!a.set.length) {
    const cur = (c) => (row ? row.cells[c] || "" : "");
    out(`intake ${name} (${row ? "row exists" : "new row"}, ${inf.inEnv ? `in ${inf.envFile}` : "not in any env file"})`);
    for (const c of COLUMNS) {
      if (c === "name") continue;
      const v = cur(c) || inf.inferred[c] || "";
      const src = cur(c) ? "ledger" : inf.inferred[c] ? "inferred" : "open";
      const col = writable.includes(c) ? "" : " [not in table]";
      out(`  ${c}: ${v || "<open>"}${v ? ` (${src})` : ""}${col}`);
    }
    out(`  name rule: ${inf.proposal ? `fails, proposal ${inf.proposal}` : "compliant"}`);
    const open = REQUIRED.filter((c) => c !== "name" && !cur(c) && !inf.inferred[c]);
    out(`open: ${open.length ? open.join(", ") : "none"}`);
    if (cfg.columnMap) out(`columnMap set: --set accepts only ${writable.filter((c) => c !== "name").join(", ")}`);
    out(`next: ${INTAKE_CMD} ${name} --project ${root} --set key=value ...`);
    return 0;
  }

  const sets = parseSets(a.set);
  if (cfg.columnMap) {
    const bad = Object.keys(sets).filter((k) => !writable.includes(k));
    if (bad.length) throw new LedgerError(`columnMap set: write refused for unmapped column(s) ${bad.join(", ")}`);
  }
  const fields = row ? sets : { ...Object.fromEntries(Object.entries(inf.inferred).filter(([k]) => writable.includes(k))), ...sets };
  const purpose = fields.purpose || (row ? row.cells.purpose : "") || "";
  // env comment first: computed and verified before any write
  let envWrite = null;
  if (inf.inEnv && purpose) {
    const comment = `${purpose}, ledger: ${name}`;
    const why = commentReasons(comment);
    if (why.length) throw new LedgerError(`env comment refused, breaks D4 (${why.join(", ")}): change purpose`);
    const p = path.join(root, inf.envFile);
    const text = fs.readFileSync(p, "utf8");
    const next = setKeyComment(text, name, comment);
    if (next !== null && next !== text) envWrite = [p, next];
  }
  const res = upsertRow(md, cfg.columnMap, name, fields);
  fs.writeFileSync(ledgerPath, res.md);
  if (envWrite) fs.writeFileSync(envWrite[0], envWrite[1]);
  const dir = path.join(root, cfg.stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const event = withId({ at: new Date().toISOString(), event: res.added ? "added" : "updated", project: cfg.project, name, fields: Object.keys(fields).sort(), env_comment: !!envWrite });
  fs.appendFileSync(path.join(dir, "history.jsonl"), JSON.stringify(event) + "\n");
  out(`intake ${name}: row ${res.added ? "added" : "updated"} (${Object.keys(fields).sort().join(", ")}), env comment ${envWrite ? "rewritten" : inf.inEnv ? (purpose ? "unchanged" : "skipped, no purpose") : "skipped, not in env files"}, history logged`);
  return 0;
}

function cmdLintEnv(a) {
  const cfg = project(a);
  if (a.fix) return cmdLintFix(a, cfg);
  const envs = loadEnvs(a.project, cfg);
  const F = [];
  const add = (level, id, subject, msg) => F.push({ level, id, subject, msg });
  envFindings(envs, findStale(a.project, cfg), add);
  commentFindings(envs, add);
  labelFindings(envNameMap(envs), () => "", add);
  report(F, `secret-ledger lint-env ${cfg.project}`);
  return exitFor(F);
}

// ---------- lint-env --fix (safety protocol) ----------
// Dry run by default: masked comment diff only. --apply: backup (mode 600) first, write, then a post
// write guard (names + value digest); mismatch = restore the backup and exit 3. Then mirror + history.

function cmdLintFix(a, cfg) {
  const root = a.project;
  let purposes = new Map();
  try {
    for (const r of loadLedger(root, cfg).rows) for (const n of r.names) purposes.set(n, r.cells.purpose || "");
  } catch {}
  const plans = [];
  for (const rel of cfg.envFiles) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, "utf8");
    const plan = planFix(text, (n) => purposes.get(n) || "");
    const kb = keyLines(text), ka = keyLines(plan.text);
    if (kb.length !== ka.length || kb.some((l, i) => l !== ka[i])) throw new LedgerError(`${rel}: fix plan would change a non comment line, refused`);
    plans.push({ rel, p, text, plan });
  }
  // diff: comment lines only; key lines as NAME=<value>
  const diff = [];
  for (const { rel, plan } of plans) {
    for (const c of plan.changes) {
      diff.push(`@@ ${rel}:${c.line} ${c.name || "loose comment"}`);
      for (const o of c.old) diff.push(`-${maskComment(o)}`);
      if (c.new) diff.push(`+${c.new.replace(/\r$/, "")}`, ` ${c.name}=<value>`);
    }
    for (const u of plan.unfixed) diff.push(`!! ${rel}:${u.line} ${u.name}: ${u.why}`);
  }
  const bad = diff.findIndex((l) => hasToken(l) || looksLikeValue(l));
  if (bad >= 0) {
    err(`lint-env --fix aborted: diff line ${bad + 1} looks like a value, nothing printed or written`);
    return 3;
  }
  const changed = plans.filter((x) => x.plan.changes.length);
  const nChanges = plans.reduce((s, x) => s + x.plan.changes.length, 0);
  const nUnfixed = plans.reduce((s, x) => s + x.plan.unfixed.length, 0);
  if (!a.apply) {
    diff.forEach((l) => out(l));
    out(`dry run: ${nChanges} comment change(s) in ${changed.length} file(s), ${nUnfixed} unfixed; backup dir ${a.backupDir}; nothing written. Apply: add --apply`);
    return 0;
  }
  if (!changed.length) {
    out("lint-env --fix: nothing to change");
    return 0;
  }
  fs.mkdirSync(a.backupDir, { recursive: true, mode: 0o700 });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backups = [];
  for (const x of changed) {
    const b = path.join(a.backupDir, `${path.basename(x.rel)}.${ts}`);
    fs.writeFileSync(b, x.text, { mode: 0o600, flag: "wx" });
    fs.chmodSync(b, 0o600);
    if (fs.readFileSync(b, "utf8") !== x.text) throw new LedgerError(`backup ${b} does not match the source, nothing written`);
    x.backup = b;
    backups.push(b);
    out(`backup ${b} sha12 ${sha(x.text).slice(0, 12)}`);
  }
  let restored = [];
  for (const x of changed) {
    const before = envDigest(x.text);
    const mode = fs.statSync(x.p).mode & 0o777;
    fs.writeFileSync(x.p, x.plan.text);
    fs.chmodSync(x.p, mode);
    if (process.env.SECRET_LEDGER_FIX_CORRUPT_PROBE === "1") fs.writeFileSync(x.p, x.plan.text.replace(/=([^\n]*)\n(?![\s\S]*=)/, "=$1x\n"));
    const after = envDigest(fs.readFileSync(x.p, "utf8"));
    if (after.hash !== before.hash || after.names.join(",") !== before.names.join(",")) {
      fs.copyFileSync(x.backup, x.p);
      fs.chmodSync(x.p, mode);
      restored.push(x.rel);
    }
  }
  if (restored.length) {
    // roll back every file of this run so the set stays consistent
    for (const x of changed) if (!restored.includes(x.rel)) {
      fs.copyFileSync(x.backup, x.p);
      restored.push(x.rel);
    }
    err(`⚠️ post write guard: names or value digest changed, restored from backup: ${restored.join(", ")}`);
    return 3;
  }
  out(`guard ok: names and value digest identical in ${changed.map((x) => x.rel).join(", ")}`);
  const lib = path.join(root, "scripts/git-hooks/lib-protect.sh");
  let mirror = "none (no scripts/git-hooks/lib-protect.sh)";
  if (fs.existsSync(lib)) {
    const r = spawnSync("bash", ["-c", '. "$1" && mirror_env', "_", lib], { cwd: root, encoding: "utf8" });
    mirror = r.status === 0 ? "refreshed via lib-protect.sh mirror_env" : `mirror_env exit ${r.status}`;
  }
  out(`mirror: ${mirror}`);
  const dir = path.join(root, cfg.stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const event = withId({ at: new Date().toISOString(), event: "env_comments_rewritten", project: cfg.project, files: changed.map((x) => x.rel), changes: nChanges, backups });
  fs.appendFileSync(path.join(dir, "history.jsonl"), JSON.stringify(event) + "\n");
  out(`applied: ${nChanges} comment change(s), ${nUnfixed} unfixed, history logged`);
  return 0;
}

// ---------- selftest (inline fixtures; file cases use a temp dir that is removed after) ----------

const fakeTokens = () => [["gh", "p_"].join("") + "Fx7".repeat(12), ["sb", "p_"].join("") + "Fx7q".repeat(10)];

function selftest() {
  const today = Date.UTC(2026, 0, 10);
  const cfg = validateConfig({ project: "fixture", prefix: "FIX", envFiles: [".secrets/.env.fixture"], secretDirs: [".secrets"], ledger: "ledger.md" });
  const envText = [
    "# === ACME OPS ===",
    "# Sync job reads, ledger: Ledger#^fix_acme_sync_ops_api_key",
    "FIX_ACME_SYNC_OPS_API_KEY=fk-000",
    "# rotated 2026-01-02",
    "FIX_ACME_PUSH_PROD_TOKEN=fk-001",
    "FIX_BETA_LEGACY_KEY=fk-002",
    "export FIX_NEW_UNLISTED_TOKEN=fk-003",
    "",
  ].join("\n");
  const row = (o) => `| ${COLUMNS.map((c) => o[c] || "").join(" | ")} | ^${o.name.toLowerCase()}`;
  const base = { project: "fixture", kind: "TOKEN", purpose: "fixture", scope: "none", created: "2026-01-01", rotation_trigger: "leak", rotation_steps: "regenerate", verify: "true", status: "active" };
  const ledgerMd = [
    "# Fixture ledger",
    "",
    `| ${COLUMNS.join(" | ")} |`,
    `|${COLUMNS.map(() => "---").join("|")}|`,
    row({ ...base, name: "FIX_ACME_SYNC_OPS_API_KEY", provider: "acme", account: "ops@example.com", env: "OPS", expires: "none (provider docs)", purpose: "sync a \\| b" }),
    row({ ...base, name: "FIX_ACME_PUSH_PROD_TOKEN", provider: "acme", account: "unknown", env: "PROD", expires: "2026-01-15" }),
    row({ ...base, name: "FIX_BETA_LEGACY_KEY", provider: "beta", account: "1234", env: "OPS", expires: "2026-01-30", copies: "store:X" }),
    row({ ...base, name: "FIX_GONE_OPS_TOKEN", provider: "gone", account: "1", env: "OPS", expires: "none (docs)" }),
    "",
    "Text below stays.",
  ].join("\n");
  const ids = (F, level) => F.filter((f) => !level || f.level === level).map((f) => `${f.id} ${f.subject}`);
  const cases = [];
  const t = (name, fn) => cases.push([name, fn]);

  const env = parseEnv(envText);
  t("parser env", () => {
    assert.equal(env.keys.size, 4);
    assert.equal(env.keys.get("FIX_ACME_SYNC_OPS_API_KEY").bannerEnv, "OPS");
    assert.deepEqual(env.keys.get("FIX_ACME_SYNC_OPS_API_KEY").reasons, []);
    assert.deepEqual(env.keys.get("FIX_ACME_PUSH_PROD_TOKEN").reasons, ["date"]);
    assert.ok(!JSON.stringify([...env.keys.values()]).includes("fk-0"));
    const d = parseEnv("A_B=1\n# === X ===\nA_B=2\n");
    assert.equal(d.duplicates.length, 1);
    assert.equal(d.beforeBanner.length, 1);
  });
  const ledger = parseLedger(ledgerMd);
  t("parser ledger", () => {
    assert.equal(ledger.mode, "fixed");
    assert.equal(ledger.rows.length, 4);
    assert.equal(ledger.rows[0].cells.purpose, "sync a | b");
    assert.equal(ledger.rows[0].cells.history_ref, "");
    assert.deepEqual(splitRow("| a \\| b | c | ^x"), ["a | b", "c"]);
    assert.throws(() => parseLedger("| x | y |\n|---|---|\n"), (e) => e.code === 2);
  });
  t("config unknown key exit 2", () => {
    assert.throws(() => validateConfig({ project: "p", prefix: "P", envFiles: ["e"], ledger: "l", typo: 1 }), (e) => e.code === 2);
  });
  const ctx = { cfg, envs: [{ rel: ".secrets/.env.fixture", parsed: env, mode: 0o644 }], stale: [".secrets/.env.fixture.bak-2026-01-01"], ledger };
  const scan = { consumers: new Map([["FIX_ACME_SYNC_OPS_API_KEY", new Set(["src/a.mjs"])]]), mentions: new Map(), literals: [], errors: [] };
  const full = runChecks({ ...ctx, scan }, { today });
  t("C1 missing row, exit 1", () => {
    assert.deepEqual(ids(full).filter((x) => x.startsWith("C1 ")), ["C1 FIX_NEW_UNLISTED_TOKEN"]);
    assert.equal(exitFor(full), 1);
  });
  t("C3 unknown account", () => assert.deepEqual(ids(full).filter((x) => x.startsWith("C3 ")), ["C3 FIX_ACME_PUSH_PROD_TOKEN"]));
  t("C4 and C5 expiry", () => {
    assert.ok(ids(full, "FAIL").includes("C4 FIX_ACME_PUSH_PROD_TOKEN"));
    assert.ok(ids(full, "WARN").includes("C5 FIX_BETA_LEGACY_KEY"));
    assert.ok(!ids(full).includes("C4 FIX_ACME_SYNC_OPS_API_KEY"));
  });
  t("C14 env_mismatch, C15 PROD", () => {
    assert.deepEqual(ids(full).filter((x) => x.startsWith("C14 ")), ["C14 FIX_ACME_PUSH_PROD_TOKEN"]);
    assert.deepEqual(ids(full).filter((x) => x.startsWith("C15 ")), ["C15 FIX_ACME_PUSH_PROD_TOKEN"]);
  });
  t("C2 orphan, C6 proposal, C7 unused", () => {
    assert.ok(ids(full, "WARN").includes("C2 FIX_GONE_OPS_TOKEN"));
    const c6 = full.find((f) => f.id === "C6" && f.subject === "FIX_BETA_LEGACY_KEY");
    assert.ok(c6 && c6.msg.endsWith("FIX_BETA_LEGACY_OPS_API_KEY"));
    assert.ok(new RegExp(cfg.namingRegex).test("FIX_BETA_LEGACY_OPS_API_KEY"));
    assert.ok(ids(full, "WARN").includes("C7 FIX_BETA_LEGACY_KEY"));
  });
  t("C9 comment, C10 mode and stale", () => {
    assert.ok(ids(full, "FAIL").includes("C9 FIX_ACME_PUSH_PROD_TOKEN"));
    assert.ok(ids(full, "FAIL").includes("C10 .secrets/.env.fixture"));
    assert.ok(ids(full, "FAIL").includes("C10 .secrets/.env.fixture.bak-2026-01-01"));
  });
  t("quick subset and budget", () => {
    const t0 = performance.now();
    const q = runChecks(ctx, { quick: true, today });
    assert.ok(performance.now() - t0 < 300);
    assert.ok(q.every((f) => ["C1", "C3", "C4", "C5", "C10"].includes(f.id)));
  });
  t("columnMap legacy ledgers", () => {
    const legacy = [
      [{ name: "Env var", provider: "Service", status: "Status", verify: "Verify", purpose: "Notes" },
        "| Env var | Service / login that owns the key | Status | Verify | Notes |\n|---|---|---|---|---|\n| FIX_ACME_SYNC_OPS_API_KEY (other env) | Acme | ok | n/a | x |\n| (no credential) | y | z | n/a | w |\n"],
      [{ name: "Credential", consumers: "Used by", scope: "Scope", account: "Account", created: "Created" },
        "| Credential | Used by | Scope | Account | Created | Restriction |\n|---|---|---|---|---|---|\n| FIX_ACME_SYNC_OPS_API_KEY | a.mjs | none | ops@example.com | 2026-01-01 | ip |\n"],
      [{ name: "Name", provider: "Provider", purpose: "Purpose", consumers: "Used by", source: "Source of truth", copies: "Copied", rotation_steps: "Rotation note" },
        "| Name | Provider | Purpose | Used by | Source of truth | Copied | Rotation note |\n|---|---|---|---|---|---|---|\n| `FIX_ACME_SYNC_OPS_API_KEY` | acme | sync | a | here | no | regen |\n"],
    ];
    for (const [cm, md] of legacy) {
      const l = parseLedger(`intro\n\n${md}`, cm);
      assert.equal(l.mode, "map");
      assert.deepEqual(l.rows.flatMap((r) => r.names), ["FIX_ACME_SYNC_OPS_API_KEY"]);
      assert.ok(l.unmapped.includes("expires"));
    }
    const l = parseLedger(legacy[0][1], legacy[0][0]);
    const F = runChecks({ ...ctx, ledger: l, cfg: { ...cfg, columnMap: legacy[0][0] }, scan }, { today });
    assert.ok(!F.some((f) => f.id === "C3" || f.id === "C4"));
    const mig = F.find((f) => f.id === "MIG" && f.subject === "ledger.md");
    assert.ok(mig && mig.msg.includes("account") && mig.tag === "migration");
  });
  t("scan refs", () => {
    const known = new Set(["FIX_A_OPS_TOKEN", "FIX_B_OPS_TOKEN"]);
    assert.deepEqual([...extractRefs("x.mjs", "process.env.FIX_A_OPS_TOKEN; env.FIX_B_OPS_TOKEN; process.env.HOME", known).refs].sort(), ["FIX_A_OPS_TOKEN", "FIX_B_OPS_TOKEN"]);
    assert.deepEqual([...extractRefs("x.sh", "echo $HOME ${FIX_A_OPS_TOKEN}", known).refs], ["FIX_A_OPS_TOKEN"]);
    assert.deepEqual([...extractRefs(".mcp.json", '{"s":{"env":{"FIX_B_OPS_TOKEN":"v"}}}', known).refs], ["FIX_B_OPS_TOKEN"]);
  });
  t("columnMap table selects the named table", () => {
    const cm = { table: "Env var index", name: "Env var", provider: "Service" };
    const tbl = (n) => `| Env var | Service |\n|---|---|\n| ${n} | acme |\n`;
    const md = `# L\n\n${tbl("FIX_FIRST_OPS_TOKEN")}\n## Env var index (2026-01-01)\n\n${tbl("FIX_SECOND_OPS_TOKEN")}`;
    assert.deepEqual(parseLedger(md, cm).rows.flatMap((r) => r.names), ["FIX_SECOND_OPS_TOKEN"]);
    assert.deepEqual(parseLedger(md, { ...cm, table: undefined }).rows.flatMap((r) => r.names), ["FIX_FIRST_OPS_TOKEN"]);
    assert.deepEqual(parseLedger(md, { ...cm, table: "env var" }).rows.flatMap((r) => r.names), ["FIX_FIRST_OPS_TOKEN"]);
    assert.throws(() => parseLedger(md, { ...cm, table: "Nope" }), (e) => e.code === 2 && /under "Nope"/.test(e.message));
    assert.equal(validateConfig({ project: "p", prefix: "P", envFiles: ["e"], ledger: "l", columnMap: cm }).columnMap.table, "Env var index");
  });
  t("C14 env segment skips the prefix and KIND", () => {
    assert.equal(envSegment("TEST_SUPABASE_URL"), "");
    assert.equal(envSegment("PROD_ACME_API_KEY"), "");
    assert.equal(envSegment("OPS_ACME_DEV_API_KEY"), "DEV");
    assert.equal(envSegment("FIX_ACME_PUSH_PROD_TOKEN"), "PROD");
    const e2 = parseEnv("# === ACME OPS ===\nTEST_ACME_SYNC_TOKEN=fk-004\n");
    const F = [];
    labelFindings(envNameMap([{ rel: "e", parsed: e2 }]), () => "OPS", (...x) => F.push(x));
    assert.equal(F.length, 0);
  });
  t("staged refs cover every scan pattern", () => {
    const known = new Set(["FIX_A_OPS_TOKEN", "FIX_B_OPS_TOKEN", "FIX_C_OPS_TOKEN", "FIX_D_OPS_TOKEN", "FIX_E_OPS_TOKEN", "FIX_F_OPS_TOKEN", "FIX_G_OPS_TOKEN", "FIX_H_OPS_TOKEN", "FIX_I_OPS_TOKEN"]);
    const files = {
      "a.mjs": "const a = process.env.FIX_A_OPS_TOKEN;",
      "b.ts": "const b = process.env['FIX_B_OPS_TOKEN'];",
      "worker/c.js": "export default { f(req, env) { return env.FIX_C_OPS_TOKEN; } };",
      "d.sh": "curl -H \"x: ${FIX_D_OPS_TOKEN}\"",
      "wrangler.toml": "name = \"w\"\n[vars]\nFIX_E_OPS_TOKEN = \"x\"",
      ".mcp.json": '{"mcpServers":{"s":{"env":{"FIX_F_OPS_TOKEN":"x"}}}}',
      ".github/workflows/ci.yml": "env:\n  T: ${{ secrets.FIX_G_OPS_TOKEN }}",
      "notes.md": "FIX_H_OPS_TOKEN in prose\n```sh\necho $FIX_I_OPS_TOKEN\n```",
      ".secrets/.env.x": "FIX_A_OPS_TOKEN=fk-000",
    };
    const diff = Object.entries(files).map(([f, t]) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -0,0 +1 @@\n${t.split("\n").map((l) => "+" + l).join("\n")}`).join("\n");
    const hits = stagedRefs(diff, (f) => files[f] ?? null, known);
    assert.deepEqual([...hits.keys()].sort(), [...known].filter((n) => n !== "FIX_H_OPS_TOKEN").sort());
    assert.equal(hits.get("FIX_A_OPS_TOKEN"), "a.mjs");
    const ctxOnly = "diff --git a/wrangler.toml b/wrangler.toml\n+++ b/wrangler.toml\n@@ -3 +3 @@\n+FIX_E_OPS_TOKEN = \"y\"";
    assert.equal(stagedRefs(ctxOnly, () => "[env]\nFIX_E_OPS_TOKEN = \"y\"", known).size, 0);
  });
  t("redact unit", () => {
    for (const tok of fakeTokens()) {
      const s = redact(`x ${tok} y`);
      assert.ok(s.includes("[redacted]") && !s.includes(tok));
    }
    assert.ok(tripped());
    resetRedact();
    rememberValue("fake-remembered-value");
    assert.equal(redact("v=fake-remembered-value"), "v=[redacted]");
    resetRedact();
  });
  t("redact probe exit 3", () => {
    const r = spawnSync(process.execPath, [SELF, "selftest"], { env: { ...process.env, SECRET_LEDGER_REDACT_PROBE: "1" }, encoding: "utf8" });
    assert.equal(r.status, 3);
    assert.ok(r.stdout.includes("[redacted]"));
    for (const tok of fakeTokens()) assert.ok(!r.stdout.includes(tok) && !r.stderr.includes(tok));
  });

  // file fixture: temp project with env (mode 600), fixed ledger and config
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "secret-ledger-selftest-"));
  const run = (...args) => spawnSync(process.execPath, [SELF, ...args, "--project", tmp], { encoding: "utf8" });
  const envFile = path.join(tmp, ".secrets/.env.fixture");
  const envFixture = ["# === ACME OPS ===", "# old note", "FIX_ACME_SYNC_OPS_API_KEY=fk-000", "FIX_NEW_UNLISTED_TOKEN=fk-003", ""].join("\n");
  const ledgerFixture = ["# Fixture ledger", "", `| ${COLUMNS.join(" | ")} |`, `|${COLUMNS.map(() => "---").join("|")}|`,
    row({ ...base, name: "FIX_ACME_SYNC_OPS_API_KEY", provider: "acme", account: "ops@example.com", env: "OPS", expires: "none (provider docs)" }), "", "Text below stays.", ""].join("\n");
  const setup = () => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(path.join(tmp, ".secrets"), { recursive: true });
    fs.writeFileSync(envFile, envFixture, { mode: 0o600 });
    fs.writeFileSync(path.join(tmp, "ledger.md"), ledgerFixture);
    fs.writeFileSync(path.join(tmp, "x.mjs"), "process.env.FIX_NEW_UNLISTED_TOKEN\n");
    fs.writeFileSync(path.join(tmp, ".secret-ledger.json"), JSON.stringify({ project: "fixture", prefix: "FIX", envFiles: [".secrets/.env.fixture"], secretDirs: [".secrets"], ledger: "ledger.md", scanInclude: ["*.mjs"] }));
  };
  t("cache: first run prints, cached rerun silent", () => {
    setup();
    const r1 = run("check", "--quick", "--hook");
    assert.equal(r1.status, 0);
    assert.ok(r1.stdout.includes("C1 FIX_NEW_UNLISTED_TOKEN"));
    assert.ok(fs.existsSync(path.join(tmp, "tools/state/secret-ledger/quick-cache.json")));
    const r2 = run("check", "--quick", "--hook", "--cached");
    assert.equal(r2.status, 0);
    assert.equal(r2.stdout + r2.stderr, "");
    fs.utimesSync(path.join(tmp, "ledger.md"), new Date(), new Date(Date.now() + 5000));
    assert.ok(run("check", "--quick", "--hook", "--cached").stdout.includes("C1 FIX_NEW_UNLISTED_TOKEN"));
  });
  t("cache: C4 prints every run with a lead line", () => {
    fs.writeFileSync(path.join(tmp, "ledger.md"), ledgerFixture.replace("none (provider docs)", "unknown"));
    run("check", "--quick", "--hook");
    const r = run("check", "--quick", "--hook", "--cached");
    assert.ok(r.stdout.startsWith("⚠️ secret-ledger: 1 key(s)"));
    assert.ok(r.stdout.includes("C4 FIX_ACME_SYNC_OPS_API_KEY") && !r.stdout.includes("C1 "));
    const none = spawnSync(process.execPath, [SELF, "check", "--quick", "--hook", "--project", path.join(tmp, "none")], { encoding: "utf8" });
    assert.equal(none.status, 0);
    assert.equal(none.stdout + none.stderr, "");
  });
  t("intake template", () => {
    setup();
    const r = run("intake", "FIX_NEW_UNLISTED_TOKEN");
    assert.equal(r.status, 0);
    for (const s of ["new row", "provider: new (inferred)", "kind: TOKEN (inferred)", "consumers: x.mjs (inferred)", "proposal FIX_NEW_UNLISTED_<ENV>_TOKEN", "open: account, env, purpose"]) assert.ok(r.stdout.includes(s), s);
    assert.ok(!r.stdout.includes("fk-0"));
  });
  t("intake --set writes row, comment, history", () => {
    setup();
    const r = run("intake", "FIX_NEW_UNLISTED_TOKEN", "--set", "purpose=push job", "--set", "env=OPS", "--set", "account=ops@example.com");
    assert.equal(r.status, 0, r.stderr);
    const md = fs.readFileSync(path.join(tmp, "ledger.md"), "utf8");
    const l = parseLedger(md);
    assert.deepEqual(l.rows.map((x) => x.names[0]), ["FIX_ACME_SYNC_OPS_API_KEY", "FIX_NEW_UNLISTED_TOKEN"]);
    assert.equal(l.rows[1].cells.purpose, "push job");
    assert.equal(l.rows[1].cells.consumers, "x.mjs");
    assert.ok(md.endsWith("\n\nText below stays.\n") && md.includes("| ^fix_new_unlisted_token"));
    const e = fs.readFileSync(envFile, "utf8").split("\n");
    assert.deepEqual(e, ["# === ACME OPS ===", "# old note", "FIX_ACME_SYNC_OPS_API_KEY=fk-000", "# push job, ledger: FIX_NEW_UNLISTED_TOKEN", "FIX_NEW_UNLISTED_TOKEN=fk-003", ""]);
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
    const h = fs.readFileSync(path.join(tmp, "tools/state/secret-ledger/history.jsonl"), "utf8").trim().split("\n").map((x) => JSON.parse(x));
    assert.equal(h[0].event, "added");
    const r2 = run("intake", "FIX_ACME_SYNC_OPS_API_KEY", "--set", "purpose=sync job");
    assert.equal(r2.status, 0);
    assert.equal(fs.readFileSync(envFile, "utf8").split("\n")[1], "# sync job, ledger: FIX_ACME_SYNC_OPS_API_KEY");
    const before = fs.readFileSync(envFile, "utf8") + fs.readFileSync(path.join(tmp, "ledger.md"), "utf8");
    assert.equal(run("intake", "FIX_ACME_SYNC_OPS_API_KEY", "--set", "purpose=renewed 2026-01-02").status, 2);
    assert.equal(run("intake", "FIX_ACME_SYNC_OPS_API_KEY", "--set", "bogus=1").status, 2);
    assert.equal(fs.readFileSync(envFile, "utf8") + fs.readFileSync(path.join(tmp, "ledger.md"), "utf8"), before);
  });
  t("staged in a git repo: block, then pass after intake", () => {
    setup();
    const git = (...x) => spawnSync("git", ["-c", "user.email=f@example.com", "-c", "user.name=f", ...x], { cwd: tmp, encoding: "utf8" });
    if (git("init", "-q").status !== 0) return;
    fs.writeFileSync(path.join(tmp, "w.sh"), "echo ${FIX_NEW_UNLISTED_TOKEN}\n");
    git("add", "w.sh", "x.mjs");
    const r = run("check", "--staged");
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes("C1 FIX_NEW_UNLISTED_TOKEN") && r.stdout.includes("intake FIX_NEW_UNLISTED_TOKEN"));
    assert.ok(!r.stdout.includes("fk-0"));
    assert.equal(run("intake", "FIX_NEW_UNLISTED_TOKEN", "--set", "purpose=push job").status, 0);
    assert.equal(run("check", "--staged").status, 0);
  });
  const fixEnv = ["# === ACME OPS ===", "# old note", "# renewed 2026-01-02", "FIX_ACME_SYNC_OPS_API_KEY=fk-000", "# FIX_OLD_OPS_TOKEN=fk-009", "", "# see https://example.test", "FIX_NEW_UNLISTED_TOKEN=fk-003", ""].join("\n");
  const fixSetup = () => {
    setup();
    fs.writeFileSync(envFile, fixEnv, { mode: 0o600 });
    return path.join(tmp, "bk");
  };
  t("fix: refused without --backup-dir", () => {
    fixSetup();
    const r = run("lint-env", "--fix");
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes("--backup-dir"));
    assert.equal(run("lint-env", "--apply").status, 2);
    assert.equal(fs.readFileSync(envFile, "utf8"), fixEnv);
  });
  t("fix: dry run prints masked comment diff only", () => {
    const bk = fixSetup();
    const r = run("lint-env", "--fix", "--backup-dir", bk);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!(r.stdout + r.stderr).includes("fk-0"));
    for (const s of ["-# renewed 2026-01-02", "+# fixture, ledger: FIX_ACME_SYNC_OPS_API_KEY", " FIX_ACME_SYNC_OPS_API_KEY=<value>", "-# FIX_OLD_OPS_TOKEN=<value>", "+# purpose open, ledger: FIX_NEW_UNLISTED_TOKEN", "dry run: 3 comment change(s)"]) assert.ok(r.stdout.includes(s), s);
    for (const l of r.stdout.trim().split("\n")) assert.ok(/^(@@ |-# |\+# | [A-Z_]+=<value>$|dry run: )/.test(l), l);
    assert.equal(fs.readFileSync(envFile, "utf8"), fixEnv);
    assert.ok(!fs.existsSync(bk));
  });
  t("fix: apply keeps names and value hash, backup, mirror, history", () => {
    const bk = fixSetup();
    fs.mkdirSync(path.join(tmp, "scripts/git-hooks"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "scripts/git-hooks/lib-protect.sh"), "mirror_env() { cp .secrets/.env.fixture mirror.copy; }\n");
    const r = run("lint-env", "--fix", "--backup-dir", bk, "--apply");
    assert.equal(r.status, 0, r.stderr);
    const now = fs.readFileSync(envFile, "utf8");
    assert.deepEqual(envDigest(now), envDigest(fixEnv));
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
    const b = fs.readdirSync(bk);
    assert.equal(b.length, 1);
    assert.ok(b[0].startsWith(".env.fixture."));
    assert.equal(fs.readFileSync(path.join(bk, b[0]), "utf8"), fixEnv);
    assert.equal(fs.statSync(path.join(bk, b[0])).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(tmp, "mirror.copy"), "utf8"), now);
    const h = fs.readFileSync(path.join(tmp, "tools/state/secret-ledger/history.jsonl"), "utf8").trim().split("\n").map((x) => JSON.parse(x));
    assert.equal(h.at(-1).event, "env_comments_rewritten");
    assert.equal(h.at(-1).backups[0], path.join(bk, b[0]));
    assert.ok(!r.stdout.includes("fk-0"));
    assert.ok(!run("lint-env").stdout.includes("C9"));
  });
  t("fix: corrupted write restores the backup and exits 3", () => {
    const bk = fixSetup();
    const r = spawnSync(process.execPath, [SELF, "lint-env", "--fix", "--backup-dir", bk, "--apply", "--project", tmp], { env: { ...process.env, SECRET_LEDGER_FIX_CORRUPT_PROBE: "1" }, encoding: "utf8" });
    assert.equal(r.status, 3);
    assert.ok(r.stderr.includes("restored from backup"));
    assert.equal(fs.readFileSync(envFile, "utf8"), fixEnv);
    assert.ok(!fs.existsSync(path.join(tmp, "tools/state/secret-ledger/history.jsonl")));
  });
  t("fix: value shaped comment aborts the diff", () => {
    const bk = fixSetup();
    fs.writeFileSync(envFile, fixEnv.replace("# old note", "# old Fx7q9Fx7q9Fx7q9Fx7q9Fx7q9Fx7q9"), { mode: 0o600 });
    const r = run("lint-env", "--fix", "--backup-dir", bk);
    assert.equal(r.status, 3);
    assert.equal(r.stdout, "");
    assert.ok(!looksLikeValue("# see docs/aluxVault/08-ops/Credentials-Registry.md."));
    assert.ok(looksLikeValue("# Fx7q/9Fx7q9Fx7q9Fx7q9Fx7q9Fx7q9"));
  });
  t("env comment guard", () => {
    assert.equal(setKeyComment("# === A OPS ===\nX_Y=1\n", "X_Y", "p, ledger: X_Y"), "# === A OPS ===\n# p, ledger: X_Y\nX_Y=1\n");
    assert.equal(setKeyComment("A_B=1\n", "X_Y", "p"), null);
    assert.throws(() => setKeyComment("X_Y=1\n", "X_Y", "a\nb"), (e) => e.code === 2);
  });

  // --all fixtures: brain dir and projects in a temp dir via SECRET_LEDGER_BRAIN_DIR
  const allTmp = fs.mkdtempSync(path.join(os.tmpdir(), "secret-ledger-all-"));
  const brain = path.join(allTmp, "brain");
  const cred = path.join(brain, "credentials");
  const runAll = (...x) => spawnSync(process.execPath, [SELF, "check", "--all", ...x], { env: { ...process.env, SECRET_LEDGER_BRAIN_DIR: brain }, encoding: "utf8" });
  const soonDate = new Date(Date.now() + 45 * 864e5).toISOString().slice(0, 10);
  const weeklyFile = () => path.join(cred, `weekly-${new Date(todayUTC()).toISOString().slice(0, 10)}.md`);
  const readB = (f) => fs.readFileSync(path.join(cred, f), "utf8");
  const histCount = () => readB("history.jsonl").trim().split("\n").length;
  const shared = "FIX_ACME_SYNC_OPS_API_KEY";
  const mkProject = (name, envLines, rows, hist) => {
    const d = path.join(allTmp, name);
    fs.mkdirSync(path.join(d, ".secrets"), { recursive: true });
    fs.writeFileSync(path.join(d, ".secrets/.env.fixture"), ["# === ACME OPS ===", ...envLines, ""].join("\n"), { mode: 0o600 });
    fs.writeFileSync(path.join(d, "ledger.md"), ["# L", "", `| ${COLUMNS.join(" | ")} |`, `|${COLUMNS.map(() => "---").join("|")}|`, ...rows.map(row), ""].join("\n"));
    const names = envLines.filter((l) => !l.startsWith("#")).map((l) => l.split("=")[0]);
    fs.writeFileSync(path.join(d, "x.mjs"), names.map((n) => `process.env.${n}`).join("\n") + "\n");
    fs.writeFileSync(path.join(d, ".secret-ledger.json"), JSON.stringify({ project: name, prefix: "FIX", envFiles: [".secrets/.env.fixture"], secretDirs: [".secrets"], ledger: "ledger.md", scanInclude: ["*.mjs"] }));
    if (hist) {
      fs.mkdirSync(path.join(d, "tools/state/secret-ledger"), { recursive: true });
      fs.writeFileSync(path.join(d, "tools/state/secret-ledger/history.jsonl"), hist.map((e) => JSON.stringify(e)).join("\n") + "\n");
    }
    return d;
  };
  const setProjects = (...names) => {
    fs.mkdirSync(cred, { recursive: true });
    fs.writeFileSync(path.join(cred, "projects.json"), JSON.stringify({ version: 1, projects: names.map((n) => ({ name: n, root: path.join(allTmp, n), config: ".secret-ledger.json", owner_agent: n })) }));
  };
  const sharedRow = (extra = {}) => ({ ...base, name: shared, provider: "acme", account: "ops@example.com", env: "OPS", expires: soonDate, purpose: "sync job", ...extra });
  const envA = ["# sync job, ledger: FIX_ACME_SYNC_OPS_API_KEY", `${shared}=fk-000`];
  const envB = [...envA, "# beta job, ledger: FIX_BETA_PUSH_OPS_TOKEN", "FIX_BETA_PUSH_OPS_TOKEN=fk-001"];
  const histA = [{ at: "2026-01-01T00:00:00Z", event: "added", project: "fixture-a", name: shared }, withId({ at: "2026-01-02T00:00:00Z", event: "updated", project: "fixture-a", name: shared })];
  mkProject("fixture-a", envA, [sharedRow()], histA);
  const noLeak = (s) => {
    assert.ok(!s.includes("fk-0"));
    for (const l of s.split("\n")) assert.ok(!hasToken(l), "token shape in output");
  };
  let idx1 = "";
  t("--all one clean project plus a missing config: index, weekly, history", () => {
    setProjects("fixture-a", "ghost");
    const r = runAll();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const lines = r.stdout.trim().split("\n");
    assert.equal(lines[0], "✓ clean fixture-a");
    assert.ok(lines[1].startsWith("△ WARN ghost: no .secret-ledger.json") && lines[1].endsWith(", skipped"));
    assert.ok(lines.at(-1).startsWith("secret-ledger check --all: 1 checked, 1 skipped, 0 config error(s), FAIL 0, WARN 0"));
    idx1 = readB("index.md");
    assert.ok(idx1.startsWith("<!-- generated by secret-ledger index, do not edit -->\n# Credentials index\n"));
    for (const s of ["projects: 1, names: 1", "## By provider account", "| acme | o***@example.com | fixture-a | 1 (🟧 1) |", "## By project", "| ghost | - | - | - | skipped:", "## Shared keys", "## Expiring in 60 days", `| 🟧 ${shared} | fixture-a | ${soonDate} |`]) assert.ok(idx1.includes(s), s);
    assert.ok(fs.readFileSync(weeklyFile(), "utf8").includes("## fixture-a\n✓ clean"));
    assert.equal(histCount(), 2);
    noLeak(r.stdout + idx1 + fs.readFileSync(weeklyFile(), "utf8") + readB("history.jsonl"));
  });
  t("--all history dedupe: second run adds nothing", () => {
    const h1 = readB("history.jsonl");
    assert.equal(runAll().status, 0);
    assert.equal(readB("history.jsonl"), h1);
    const ids = h1.trim().split("\n").map((l) => JSON.parse(l).id);
    assert.equal(ids[1], histA[1].id);
    assert.ok(/^[0-9a-f]{12}$/.test(ids[0]));
  });
  t("--all second project: FAIL exit 1, index changes, C8 shared name", () => {
    mkProject("fixture-b", envB, [sharedRow({ project: "fixture-b" })], [{ at: "2026-01-03T00:00:00Z", event: "added", project: "fixture-b", name: shared }]);
    setProjects("fixture-a", "fixture-b");
    const r = runAll();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.ok(r.stdout.includes("⚠️ FAIL fixture-a: FAIL 1, WARN 0"));
    assert.ok(r.stdout.includes("⚠️ FAIL fixture-b: FAIL 2, WARN 0"));
    const idx2 = readB("index.md");
    assert.notEqual(idx2, idx1);
    assert.ok(idx2.includes("projects: 2, names: 3"));
    assert.ok(idx2.includes(`| 🟧 ${shared} | unlinked (C8) | fixture-a, fixture-b |`));
    assert.ok(idx2.includes("| acme | o***@example.com | fixture-a, fixture-b | 2 (🟧 2) |"));
    const w = fs.readFileSync(weeklyFile(), "utf8");
    assert.ok(w.includes("| C8 | 1 | 0 |") && w.includes("| C1 | 1 | 0 |"));
    assert.ok(w.includes(`- ⚠️ FAIL C8 ${shared}: consumer in project fixture-b, row has no source / shared_with link`));
    assert.ok(w.includes("- ⚠️ FAIL C1 FIX_BETA_PUSH_OPS_TOKEN: env name has no ledger row"));
    assert.equal(histCount(), 3);
    assert.equal(runAll().status, 1);
    assert.equal(histCount(), 3);
    noLeak(r.stdout + idx2 + w + readB("history.jsonl"));
  });
  t("--all C8 clears once source is set", () => {
    mkProject("fixture-b", envB, [sharedRow({ project: "fixture-b", source: "fixture-a" })]);
    const r = runAll();
    assert.ok(!r.stdout.includes("fixture-a: FAIL 1") && r.stdout.includes("✓ clean fixture-a"));
    assert.ok(!fs.readFileSync(weeklyFile(), "utf8").includes("| C8 |"));
    assert.ok(readB("index.md").includes(`| 🟧 ${shared} | fixture-a | fixture-a, fixture-b |`));
  });
  t("--all redacts a token shaped ledger cell in index and weekly, exit 3", () => {
    const tok = fakeTokens()[0];
    mkProject("fixture-b", envB, [sharedRow({ project: "fixture-b", source: "fixture-a", account: tok })]);
    const r = runAll();
    assert.equal(r.status, 3);
    const all = r.stdout + r.stderr + readB("index.md") + fs.readFileSync(weeklyFile(), "utf8");
    assert.ok(!all.includes(tok) && readB("index.md").includes("[redacted]"));
  });
  t("--all config errors exit 2", () => {
    fs.writeFileSync(path.join(cred, "projects.json"), "{ nope");
    assert.equal(runAll().status, 2);
    setProjects("fixture-a");
    assert.equal(runAll("--quick").status, 2);
    assert.equal(spawnSync(process.execPath, [SELF, "check", "--all"], { env: { ...process.env, SECRET_LEDGER_BRAIN_DIR: path.join(allTmp, "empty") }, encoding: "utf8" }).status, 2);
  });

  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      fn();
      out(`ok ${name}`);
    } catch (e) {
      failed++;
      out(`FAIL ${name}: ${e.message}`);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(allTmp, { recursive: true, force: true });
  resetRedact();
  out(failed ? `selftest: ${failed} of ${cases.length} failed` : `selftest: ${cases.length} cases ok`);
  return failed ? 1 : 0;
}

// ---------- main ----------

function main() {
  let a = { hook: process.argv[2] === "check" && process.argv.includes("--hook") };
  try {
    a = parseArgs(process.argv.slice(2));
    if (a.cmd === "selftest" && process.env.SECRET_LEDGER_REDACT_PROBE === "1") {
      out(`probe: ${fakeTokens().join(" ")}`);
      return finish(0);
    }
    const run = { check: cmdCheck, scan: cmdScan, "lint-env": cmdLintEnv, intake: cmdIntake, selftest }[a.cmd];
    finish(run(a), a.hook);
  } catch (e) {
    err(e instanceof LedgerError ? e.message : `internal error: ${e && e.message ? e.message : "unknown"}`);
    finish(e instanceof LedgerError ? e.code : 2, a.hook);
  }
}

main();
