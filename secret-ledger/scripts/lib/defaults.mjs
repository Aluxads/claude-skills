// Defaults for secret-ledger. Every value here can be overridden by the project config.
export const COLUMNS = [
  "name", "project", "provider", "account", "env", "kind", "purpose", "scope", "consumers", "source",
  "shared_with", "copies", "created", "expires", "rotation_trigger", "rotation_steps", "verify",
  "last_verified", "status", "history_ref",
];
export const REQUIRED = [
  "name", "project", "provider", "account", "env", "kind", "purpose", "scope", "created", "expires",
  "rotation_trigger", "rotation_steps", "verify", "status",
];
export const ENVS = ["PROD", "OPS", "TEST", "DEV", "LOCAL"];
export const KINDS = [
  "API_KEY", "TOKEN", "SECRET", "REFRESH_TOKEN", "CLIENT_ID", "CLIENT_SECRET", "SA_JSON", "URL", "ID",
  "PAT", "SESSION", "PASSWORD",
];
// legacy name suffix -> KIND, used only for the naming proposal
export const KIND_ALIASES = {
  KEY: "API_KEY", APIKEY: "API_KEY", PERSONAL_ACCESS_TOKEN: "PAT", ACCESS_TOKEN: "TOKEN",
  SERVICE_ACCOUNT_JSON: "SA_JSON", PASS: "PASSWORD", PW: "PASSWORD", ACCOUNT_ID: "ID",
};
export const SCAN_EXCLUDE = ["node_modules/**", "dist/**", ".git/**", "archive/**"];
export const STATE_DIR = "tools/state/secret-ledger";
export const WARN_DAYS = 30;
export const FAIL_DAYS = 7;
export const VERIFY_MAX_DAYS = 90;

export const namingRegexFor = (prefix) =>
  `^${prefix}_[A-Z0-9]+(_[A-Z0-9]+)?_[A-Z0-9]+_(${ENVS.join("|")})_(${KINDS.join("|")})$`;

// Token shapes, union of the pre-commit hook regexes. Prefixes are joined at runtime so this
// file never matches its own patterns or a token scanner.
const j = (...p) => p.join("");
export const TOKEN_PATTERNS = [
  "-----BEGIN [A-Z ]*PRIVATE KEY-----",
  j("sb_", "secret_[A-Za-z0-9_]+"),
  j("sb", "p_[A-Za-z0-9_]{30,}"),
  j("github", "_pat_[A-Za-z0-9_]{20,}"),
  j("gh", "p_[A-Za-z0-9]{20,}"),
  j("AI", "za[0-9A-Za-z_-]{35}"),
  j("AK", "IA[0-9A-Z]{16}"),
  j("xo", "x[bpars]-[A-Za-z0-9-]{10,}"),
  j("ph", "x_[A-Za-z0-9]{20,}"),
  "re_[A-Za-z0-9]{20,}_[A-Za-z0-9]{10,}",
  "pat-(?:na|eu)[0-9]-[0-9a-f-]{30,}",
  j("(?<![A-Za-z0-9_-])s", "k-[A-Za-z0-9_-]{20,}"),
  "(?<![A-Za-z0-9])AQ\\.[A-Za-z0-9_-]{20,}",
  j("\\bBear", "er\\s+(?![$<{`'\"])[A-Za-z0-9._~+/-]{16,}=*"),
];
