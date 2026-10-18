// Load and validate <root>/.secret-ledger.json. Unknown keys are an error so a typo never disables a check.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { COLUMNS, SCAN_EXCLUDE, STATE_DIR, namingRegexFor } from "./defaults.mjs";

export class LedgerError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.code = code;
  }
}

export const CONFIG_FILE = ".secret-ledger.json";
const REQUIRED_KEYS = ["project", "prefix", "envFiles", "ledger"];
const OPTIONAL_KEYS = ["secretDirs", "scanInclude", "scanExclude", "namingRegex", "stateDir", "columnMap", "stores", "redactExtra"];

export const expandHome = (p) => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);

const strList = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

function compiles(src) {
  try {
    new RegExp(src);
    return true;
  } catch {
    return false;
  }
}

export function validateConfig(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new LedgerError("config: not a JSON object");
  const unknown = Object.keys(obj).filter((k) => !REQUIRED_KEYS.includes(k) && !OPTIONAL_KEYS.includes(k));
  if (unknown.length) throw new LedgerError(`config: unknown key(s): ${unknown.join(", ")}`);
  const missing = REQUIRED_KEYS.filter((k) => obj[k] === undefined);
  if (missing.length) throw new LedgerError(`config: missing key(s): ${missing.join(", ")}`);
  if (typeof obj.project !== "string" || !obj.project) throw new LedgerError("config: project must be a string");
  if (typeof obj.prefix !== "string" || !/^[A-Z][A-Z0-9]*$/.test(obj.prefix)) throw new LedgerError("config: prefix must match ^[A-Z][A-Z0-9]*$");
  if (!strList(obj.envFiles) || !obj.envFiles.length) throw new LedgerError("config: envFiles must be a non empty string list");
  if (typeof obj.ledger !== "string" || !obj.ledger) throw new LedgerError("config: ledger must be a string");
  for (const k of ["secretDirs", "scanInclude", "scanExclude", "redactExtra"]) {
    if (obj[k] !== undefined && !strList(obj[k])) throw new LedgerError(`config: ${k} must be a string list`);
  }
  if (obj.namingRegex !== undefined && (typeof obj.namingRegex !== "string" || !compiles(obj.namingRegex))) throw new LedgerError("config: namingRegex does not compile");
  if ((obj.redactExtra || []).some((s) => !compiles(s))) throw new LedgerError("config: redactExtra entry does not compile");
  if (obj.stateDir !== undefined && typeof obj.stateDir !== "string") throw new LedgerError("config: stateDir must be a string");
  if (obj.stores !== undefined && (typeof obj.stores !== "object" || Array.isArray(obj.stores))) throw new LedgerError("config: stores must be an object");
  const cm = obj.columnMap ?? null;
  if (cm !== null) {
    if (typeof cm !== "object" || Array.isArray(cm)) throw new LedgerError("config: columnMap must be an object or null");
    const bad = Object.keys(cm).filter((k) => k !== "table" && !COLUMNS.includes(k));
    if (bad.length) throw new LedgerError(`config: columnMap unknown column(s): ${bad.join(", ")}`);
    if (Object.values(cm).some((v) => typeof v !== "string" || !v)) throw new LedgerError("config: columnMap values must be header strings");
    if (!cm.name) throw new LedgerError("config: columnMap must map name");
  }
  return {
    project: obj.project,
    prefix: obj.prefix,
    envFiles: obj.envFiles,
    ledger: obj.ledger,
    secretDirs: obj.secretDirs || [],
    scanInclude: obj.scanInclude || ["**"],
    scanExclude: [...SCAN_EXCLUDE, ...(obj.scanExclude || [])],
    namingRegex: obj.namingRegex || namingRegexFor(obj.prefix),
    stateDir: obj.stateDir || STATE_DIR,
    columnMap: cm,
    stores: obj.stores || {},
    redactExtra: obj.redactExtra || [],
  };
}

// Returns null when the project has no config file.
export function loadConfig(root, configFile = CONFIG_FILE) {
  const file = path.join(root, configFile);
  if (!fs.existsSync(file)) return null;
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new LedgerError(`config: ${CONFIG_FILE} is not valid JSON`);
  }
  return validateConfig(obj);
}
