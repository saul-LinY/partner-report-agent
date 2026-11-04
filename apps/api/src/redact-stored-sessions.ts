import { redactSessionCredentials } from "@partner-report/contracts";
import { HIDDEN } from "@partner-report/contracts/privacy";
import { closeDatabase, sqlClient as sql } from "@partner-report/db";
import { collectorSessionsSchema } from "./collector-contracts.js";

// Removes credentials from sessions that were stored before upload-time redaction existed.
// Dry run by default: it only counts and prints redacted context; --apply rewrites the rows.
const apply = process.argv.includes("--apply");
const SAMPLE_LIMIT = 40;
const CONTEXT = 24;

type Part = { upload_id: string; part_index: number; sessions: unknown };

function snippets(text: string) {
  const found: string[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(HIDDEN, from);
    if (at < 0) break;
    found.push(
      text
        .slice(Math.max(0, at - CONTEXT), at + HIDDEN.length + CONTEXT)
        .replace(/\s+/g, " "),
    );
    from = at + HIDDEN.length;
  }
  return found;
}

const parts = await sql<Part[]>`
  select upload_id, part_index, sessions from collector_upload_parts order by upload_id, part_index`;
let changedParts = 0;
let unparseable = 0;
let changedFields = 0;
const samples: string[] = [];
const rewrites: Array<{
  upload_id: string;
  part_index: number;
  sessions: string;
}> = [];

for (const part of parts) {
  const parsed = collectorSessionsSchema.safeParse(part.sessions);
  if (!parsed.success) {
    unparseable += 1;
    continue;
  }
  const redacted = redactSessionCredentials(parsed.data);
  let partChanged = false;
  parsed.data.forEach((session, s) => {
    const next = redacted[s]!;
    const pairs: Array<[string | null | undefined, string | null | undefined]> =
      [
        [session.title, next.title],
        ...session.turns.flatMap((turn, t) => [
          [turn.prompt, next.turns[t]!.prompt] as [string, string],
          [turn.answer, next.turns[t]!.answer] as [
            string | null | undefined,
            string | null | undefined,
          ],
        ]),
      ];
    for (const [before, after] of pairs) {
      if (before === after) continue;
      partChanged = true;
      changedFields += 1;
      if (samples.length < SAMPLE_LIMIT && after)
        samples.push(...snippets(after).slice(0, 1));
    }
  });
  if (partChanged) {
    changedParts += 1;
    rewrites.push({
      upload_id: part.upload_id,
      part_index: part.part_index,
      sessions: JSON.stringify(redacted),
    });
  }
}

console.log(
  JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    parts: parts.length,
    changedParts,
    changedFields,
    unparseable,
  }),
);
console.log("redacted context (secrets are already hidden here):");
for (const sample of samples) console.log("  ·", sample);

if (apply && rewrites.length)
  await sql.begin(async (tx) => {
    for (const row of rewrites)
      await tx`update collector_upload_parts set sessions = ${row.sessions}::jsonb
        where upload_id = ${row.upload_id} and part_index = ${row.part_index}`;
  });
if (apply) console.log(`rewrote ${rewrites.length} part(s)`);
await closeDatabase();
