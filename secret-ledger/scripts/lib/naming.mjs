// D2 naming: <PREFIX>_<PROVIDER>_<PURPOSE>_<ENV>_<KIND>, plus a compliant proposal for legacy names.
import { ENVS, KINDS, KIND_ALIASES } from "./defaults.mjs";

const SUFFIXES = [...KINDS.map((k) => [k, k]), ...Object.entries(KIND_ALIASES)].sort(
  (a, b) => b[0].split("_").length - a[0].split("_").length,
);
const slug = (s) => (s || "").toUpperCase().replace(/[^A-Z0-9]+/g, "");

// Inferred parts of a name: provider, purpose, env, kind ("<X>" when unknown).
export function nameParts(name, prefix, row = {}) {
  let segs = name.split("_").filter(Boolean);
  if (segs[0] === prefix) segs = segs.slice(1);
  let kind = "<KIND>";
  for (const [suffix, k] of SUFFIXES) {
    const s = suffix.split("_");
    if (segs.length > s.length && segs.slice(-s.length).join("_") === suffix) {
      kind = k;
      segs = segs.slice(0, -s.length);
      break;
    }
  }
  let env = slug(row.env);
  const ei = segs.findIndex((s) => ENVS.includes(s));
  if (ei >= 0) {
    env = env || segs[ei];
    segs.splice(ei, 1);
  }
  if (!ENVS.includes(env)) env = "<ENV>";
  let provider = /^[a-z0-9-]{1,24}$/i.test((row.provider || "").trim()) ? slug(row.provider) : "";
  if (provider && segs[0] === provider) segs = segs.slice(1);
  if (!provider) provider = segs.shift() || "<PROVIDER>";
  const purpose = segs.join("") || "<PURPOSE>";
  return { provider, purpose, env, kind };
}

export function propose(name, prefix, row = {}) {
  const p = nameParts(name, prefix, row);
  return [prefix, p.provider, p.purpose, p.env, p.kind].join("_");
}

// Env label from the name: a segment after the leading prefix and before KIND. The first segment is
// always the prefix (project or foreign), so a prefix equal to an env word is never the env.
export function envSegment(name) {
  const segs = name.split("_").filter(Boolean).slice(1);
  const suf = SUFFIXES.find(([x]) => {
    const s = x.split("_");
    return segs.length > s.length && segs.slice(-s.length).join("_") === x;
  });
  const body = segs.slice(0, segs.length - (suf ? suf[0].split("_").length : 1));
  return body.find((s) => ENVS.includes(s)) || "";
}
