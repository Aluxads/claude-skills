---
name: gsd-mode
description: Full blast day mode for Claude Code. No session limit stops, no handoff unless asked, only tasks that need no human decision (oldest first), one git worktree per agent, all questions batched into a single question list at the end. Persists for the day across sessions and projects. Triggers "/gsd", "/gsd on", "/gsd off", "full blast", "GSD mode", "blast day".
---

# GSD mode (get stuff done, full blast day)

Turn Claude Code into an uninterrupted working day with one command.

## What the mode changes

1. No session limit stops. No "session at limit" warning, no cold start block, no handoff unless you ask. You compact or clear when you decide.
2. Agents work only tasks that need no human decision, oldest open tasks first, and never stop to ask mid batch; all questions go into a single question list at the end.
3. Every agent session works in its own git worktree under `.claude/worktrees/` and claims its tasks (for example `| claim Name` on the task line) before the first tracked edit.
4. The mode persists across sessions for the whole day and across projects, read from `~/.claude/.gsd-mode`.

These override your project rules on session limits, handoff timing and mid task check ins for the day. Approval rules stay: deploys, live backend writes, page deletes, URL changes and pushes that trigger CI still need your approval; they are queued into the final question list.

## Commands

- `/gsd on`: write today's date to the flag: `date +%F > ~/.claude/.gsd-mode`
- `/gsd off`: delete the flag: `rm -f ~/.claude/.gsd-mode`
- `/gsd`: status: `cat ~/.claude/.gsd-mode 2>/dev/null`; ON when the date equals today, else OFF.

## Hook

`scripts/gsd-mode-hook.mjs` is a `UserPromptSubmit` hook. While the flag date equals today it injects the mode line into every prompt; a stale flag is deleted silently. Install:

```
mkdir -p ~/.claude/hooks
cp ~/.claude/skills/gsd-mode/scripts/gsd-mode-hook.mjs ~/.claude/hooks/
```

Then add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "node ~/.claude/hooks/gsd-mode-hook.mjs" } ] }
    ]
  }
}
```

## Task picking rule

1. Open tasks (`- [ ]`) in your project task list (for example `TODO.md`).
2. Skip any task marked as needing a human decision.
3. Skip any task whose linked spec still has an open question for you.
4. Skip tasks already claimed by another live agent.
5. Sort by task date, oldest first. Work in that order.

## Reply format in mode

- Short progress lines while working are allowed.
- One joint reply per batch, after every agent and check has finished.
- Questions only at batch end, as a single numbered question list, recommended option marked.
- Never a handoff block, never a cold start block, never a session limit warning.
