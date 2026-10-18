// History events: stable event id, project to brain mirror deduplicated by id. Brain file is append only.
import crypto from "node:crypto";
import fs from "node:fs";

export const eventTs = (e) => e.ts || e.at || "";
// id = sha12 of ts + event + name + project, so a re-read event maps to the same id.
export const eventId = (e) =>
  crypto.createHash("sha256").update([eventTs(e), e.event || "", e.name || "", e.project || ""].join("\n")).digest("hex").slice(0, 12);
export const withId = (e) => (e.id ? e : { id: eventId(e), ...e });

// Parsed events of a JSONL file; unparsable lines are counted, never echoed.
export function readJsonl(file) {
  const events = [];
  let bad = 0;
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { events, bad };
  }
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    try {
      const e = JSON.parse(l);
      if (e && typeof e === "object" && !Array.isArray(e)) events.push(e);
      else bad++;
    } catch {
      bad++;
    }
  }
  return { events, bad };
}

// Events from `events` whose id is not yet in the brain file, in source order, ids added.
export function newEvents(events, brainEvents, project) {
  const seen = new Set(brainEvents.map((e) => withId(e).id));
  const add = [];
  for (const raw of events) {
    const e = withId({ ...raw, project: raw.project || project });
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    add.push(e);
  }
  return add;
}
