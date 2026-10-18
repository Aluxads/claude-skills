# secret-ledger

Checks that every secret in a project env file has a row in a markdown ledger: owner login, env label, expiry, consumers. Names only, never a value.

```sh
node scripts/ledger.mjs selftest
node scripts/ledger.mjs check --project <root>
node scripts/ledger.mjs check --quick --hook --project <root>
node scripts/ledger.mjs scan --project <root>
node scripts/ledger.mjs lint-env --project <root>
```

Config: `<root>/.secret-ledger.json`. Node 20+, no dependencies. Details and exit codes in `SKILL.md`.
