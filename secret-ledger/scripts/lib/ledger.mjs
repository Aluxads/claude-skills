// Markdown ledger table parser. Fixed columns, or a legacy table read through columnMap.
import { COLUMNS } from "./defaults.mjs";
import { LedgerError } from "./config.mjs";

// Cells split on unescaped "|"; "\|" stays inside a cell; trailing " ^anchor" block id dropped.
export function splitRow(line) {
  const s = line.trim().replace(/\s+\^[A-Za-z0-9_-]+$/, "");
  if (s.length < 2 || !s.startsWith("|") || !s.endsWith("|") || s.endsWith("\\|")) return null;
  const cells = [];
  let cur = "";
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  return cells;
}

const isSep = (cells) => cells && cells.length && cells.every((c) => /^:?-{3,}:?$/.test(c));

function matchHeader(head, columnMap) {
  const low = head.map((c) => c.toLowerCase());
  const idx = {};
  if (!columnMap) {
    for (const col of COLUMNS) {
      const i = low.indexOf(col);
      if (i < 0) return null;
      idx[col] = i;
    }
    return idx;
  }
  for (const [col, legacy] of Object.entries(columnMap)) {
    if (col === "table") continue;
    const l = legacy.toLowerCase();
    const i = low.findIndex((c) => c === l || c.startsWith(l + " "));
    if (i < 0) return null;
    idx[col] = i;
  }
  return idx;
}

// Env names inside a cell. Wildcards like PREFIX_* are skipped.
export function extractNames(cell) {
  const s = (cell || "").replace(/`/g, "");
  return [...new Set([...s.matchAll(/(?<![A-Za-z0-9_])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?![A-Za-z0-9_*])/g)].map((m) => m[0]))];
}

// columnMap.table: only a table under a heading starting with that text, or whose first header cell equals it.
const tableOk = (want, heading, head) => !want || heading.startsWith(want) || (head[0] || "").toLowerCase() === want;

export function parseLedger(md, columnMap = null) {
  const lines = md.split(/\r?\n/);
  const want = (columnMap?.table || "").trim().toLowerCase();
  let heading = "";
  for (let i = 0; i < lines.length - 1; i++) {
    const h = lines[i].match(/^#{1,6}\s+(.*)$/);
    if (h) heading = h[1].trim().toLowerCase();
    if (!lines[i].trim().startsWith("|")) continue;
    if (i > 0 && lines[i - 1].trim().startsWith("|")) continue;
    const head = splitRow(lines[i]);
    if (!head || !isSep(splitRow(lines[i + 1]))) continue;
    if (!tableOk(want, heading, head)) continue;
    const idx = matchHeader(head, columnMap);
    if (!idx) continue;
    const rows = [];
    let j = i + 2;
    for (; j < lines.length && lines[j].trim().startsWith("|"); j++) {
      const cells = splitRow(lines[j]);
      if (!cells) continue;
      const row = { line: j + 1, cells: {} };
      for (const [col, k] of Object.entries(idx)) row.cells[col] = (cells[k] || "").trim();
      row.names = extractNames(row.cells.name);
      rows.push(row);
    }
    return {
      mode: columnMap ? "map" : "fixed",
      start: i + 1,
      end: j,
      idx,
      rows,
      unmapped: COLUMNS.filter((c) => idx[c] === undefined),
    };
  }
  throw new LedgerError(columnMap ? `ledger: no table matches the columnMap headers${want ? ` under "${columnMap.table}"` : ""}` : "ledger: no table matches the fixed column set");
}

const esc = (v) => String(v ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
const anchorOf = (line) => (line.trim().match(/\s(\^[A-Za-z0-9_-]+)$/) || [])[1] || "";

// Insert or update the row for `name`. Only the table block changes; text above and below is kept.
// Fixed mode: rows sorted by name, anchor ^<name lowercased>. columnMap mode: only mapped columns,
// row updated in place or appended, no sort.
export function upsertRow(md, columnMap, name, fields) {
  const led = parseLedger(md, columnMap);
  const bad = Object.keys(fields).filter((k) => led.idx[k] === undefined);
  if (bad.length) throw new LedgerError(`ledger: column(s) not in the table${columnMap ? " (columnMap)" : ""}: ${bad.join(", ")}`);
  const lines = md.split("\n");
  const cr = lines[led.start - 1].endsWith("\r") ? "\r" : "";
  const width = splitRow(lines[led.start - 1]).length;
  const existing = led.rows.find((r) => r.names.includes(name));
  const cells = existing ? splitRow(lines[existing.line - 1]) : Array(width).fill("");
  while (cells.length < width) cells.push("");
  if (!existing) cells[led.idx.name] = name;
  for (const [k, v] of Object.entries(fields)) cells[led.idx[k]] = v;
  const anchor = columnMap ? (existing ? anchorOf(lines[existing.line - 1]) : "") : `^${name.toLowerCase()}`;
  const row = `| ${cells.map(esc).join(" | ")} |${anchor ? ` ${anchor}` : ""}${cr}`;
  let body = lines.slice(led.start + 1, led.end);
  if (existing) body[existing.line - 1 - (led.start + 1)] = row;
  else body.push(row);
  if (!columnMap) {
    const key = (l) => {
      const c = splitRow(l);
      return (c && extractNames(c[led.idx.name])[0]) || l;
    };
    body = body.map((l) => [key(l), l]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((x) => x[1]);
  }
  return { md: [...lines.slice(0, led.start + 1), ...body, ...lines.slice(led.end)].join("\n"), added: !existing };
}
