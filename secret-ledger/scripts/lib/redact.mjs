// The single output filter. Every printed line passes through redact().
import { TOKEN_PATTERNS } from "./defaults.mjs";

let patterns = TOKEN_PATTERNS.map((s) => new RegExp(s, "g"));
const values = new Set();
let hit = false;

export function addPatterns(list = []) {
  for (const s of list) patterns.push(new RegExp(s, "g"));
}

// Values seen during a run (P6 copy checks). Held for the run only, never serialized.
export function rememberValue(v) {
  if (typeof v === "string" && v.length >= 16) values.add(v);
}

export function redact(text) {
  let s = String(text);
  for (const re of patterns) {
    re.lastIndex = 0;
    if (re.test(s)) {
      hit = true;
      re.lastIndex = 0;
      s = s.replace(re, "[redacted]");
    }
  }
  for (const v of values) {
    if (s.includes(v)) {
      hit = true;
      s = s.split(v).join("[redacted]");
    }
  }
  return s;
}

// Detection only (C13), does not trip the run.
export function hasToken(line) {
  return patterns.some((re) => {
    re.lastIndex = 0;
    return re.test(line);
  });
}

export const tripped = () => hit;

export function resetRedact() {
  hit = false;
  values.clear();
  patterns = TOKEN_PATTERNS.map((s) => new RegExp(s, "g"));
}
