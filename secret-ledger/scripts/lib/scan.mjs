// Consumer scan (D5): env references in code, mentions in docs, literal token shapes (C13).
import fs from "node:fs";
import path from "node:path";
import { hasToken } from "./redact.mjs";

const MAX_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git"]);

export function globToRe(g) {
  let r = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      i++;
      if (g[i + 1] === "/") {
        i++;
        r += "(?:.*/)?";
      } else r += ".*";
    } else if (c === "*") r += "[^/]*";
    else if (c === "?") r += "[^/]";
    else r += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${r}$`);
}

const globBase = (g) => {
  const segs = g.split("/");
  const k = segs.findIndex((s) => /[*?]/.test(s));
  return k < 0 ? { base: g, file: true } : { base: segs.slice(0, k).join("/"), file: false };
};

function walk(root, rel, excluded, cb) {
  let ents;
  try {
    ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !excluded(`${r}/`)) walk(root, r, excluded, cb);
    } else if (e.isFile() && !excluded(r)) cb(r);
  }
}

export function kindOf(rel) {
  const b = path.basename(rel);
  const e = path.extname(rel).toLowerCase();
  if (b === ".mcp.json") return "mcp";
  if (b === "wrangler.toml") return "wrangler";
  if (/^\.github\/workflows\//.test(rel) && (e === ".yml" || e === ".yaml")) return "workflow";
  if ([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx", ".astro"].includes(e)) return "js";
  if ([".sh", ".bash", ".zsh", ".yml", ".yaml"].includes(e) || /^Dockerfile/.test(b)) return "shell";
  if (e === ".md") return "md";
  if ([".json", ".toml", ".txt", ".env.example"].includes(e)) return "text";
  return null;
}

const JS_RES = [/process\.env\.([A-Z][A-Z0-9_]+)/g, /process\.env\[['"]([A-Z][A-Z0-9_]+)['"]\]/g, /\benv\.([A-Z][A-Z0-9_]+)/g];
const SHELL_RE = /\$\{?([A-Z][A-Z0-9_]+)\}?/g;
const SECRETS_RE = /secrets\.([A-Z][A-Z0-9_]+)/g;
const REF_RE = /\$\{([A-Z][A-Z0-9_]+)\}/g;

const grab = (text, re, known, into) => {
  for (const m of text.matchAll(re)) if (known.has(m[1])) into.add(m[1]);
};

// Names referenced by one file. Only names in `known` count, so $HOME and $PATH never land.
export function extractRefs(rel, text, known) {
  const refs = new Set();
  const kind = kindOf(rel);
  if (kind === "js") JS_RES.forEach((re) => grab(text, re, known, refs));
  else if (kind === "shell") grab(text, SHELL_RE, known, refs);
  else if (kind === "workflow") {
    grab(text, SECRETS_RE, known, refs);
    grab(text, SHELL_RE, known, refs);
  } else if (kind === "md") {
    for (const m of text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)) grab(m[1], SHELL_RE, known, refs);
  } else if (kind === "wrangler") {
    let section = "";
    for (const line of text.split(/\r?\n/)) {
      const s = line.match(/^\s*\[([^\]]+)\]/);
      if (s) section = s[1].trim();
      else if (section === "vars") {
        const m = line.match(/^\s*([A-Z][A-Z0-9_]+)\s*=/);
        if (m && known.has(m[1])) refs.add(m[1]);
      }
    }
  } else if (kind === "mcp") {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      return { refs, error: "unparsable JSON" };
    }
    const visit = (o, inEnv) => {
      if (typeof o === "string") return grab(o, REF_RE, known, refs);
      if (!o || typeof o !== "object") return;
      for (const [k, v] of Object.entries(o)) {
        if (inEnv && known.has(k)) refs.add(k);
        visit(v, k === "env");
      }
    };
    visit(obj, false);
  }
  return { refs };
}

const literalLines = (rel, text, out) => {
  text.split(/\r?\n/).forEach((l, i) => {
    if (hasToken(l)) out.push({ file: rel, line: i + 1 });
  });
};

export function scanProject(root, cfg, known) {
  const exRes = [...cfg.scanExclude, ...cfg.envFiles, ...cfg.secretDirs.map((d) => `${d.replace(/\/$/, "")}/**`)].map(globToRe);
  const excluded = (r) => exRes.some((re) => re.test(r));
  const files = new Set();
  for (const g of cfg.scanInclude) {
    const re = globToRe(g);
    const { base, file } = globBase(g);
    if (file) {
      if (!excluded(base) && fs.existsSync(path.join(root, base))) files.add(base);
    } else walk(root, base, excluded, (r) => re.test(r) && files.add(r));
  }
  const consumers = new Map([...known].map((n) => [n, new Set()]));
  const mentions = new Map([...known].map((n) => [n, new Set()]));
  const literals = [];
  const errors = [];
  const read = (r) => {
    const p = path.join(root, r);
    try {
      if (fs.statSync(p).size > MAX_BYTES) return null;
      return fs.readFileSync(p, "utf8");
    } catch {
      return null;
    }
  };
  for (const r of files) {
    if (!kindOf(r)) continue;
    const text = read(r);
    if (text === null) continue;
    const { refs, error } = extractRefs(r, text, known);
    if (error) errors.push({ file: r, error });
    refs.forEach((n) => consumers.get(n).add(r));
    literalLines(r, text, literals);
  }
  const ledgerRel = cfg.ledger.replace(/^\.\//, "");
  walk(root, "docs", excluded, (r) => {
    if (!r.endsWith(".md") || files.has(r)) return;
    const text = read(r);
    if (text === null) return;
    if (r !== ledgerRel) {
      for (const m of text.matchAll(/[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+/g)) if (known.has(m[0])) mentions.get(m[0]).add(r);
    }
    literalLines(r, text, literals);
  });
  return { files: files.size, consumers, mentions, literals, errors };
}
