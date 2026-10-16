#!/usr/bin/env node
// UserPromptSubmit hook: injects GSD mode line while ~/.claude/.gsd-mode holds today's date.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const flag = path.join(os.homedir(), '.claude', '.gsd-mode');
try {
  const date = fs.readFileSync(flag, 'utf8').trim();
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (date === today) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `GSD MODE ON (${date}): no session limit stops, no handoff unless asked, decision-free tasks only, worktree per agent, questions batched into one list at the end`
      }
    }));
  } else {
    fs.rmSync(flag, { force: true });
  }
} catch {
  // no flag or unreadable: mode off, print nothing
}
