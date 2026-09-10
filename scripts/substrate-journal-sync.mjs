#!/usr/bin/env node
// substrate-journal-sync.mjs — write kanban state deltas back into this repo.
//
// The kanban board holds the canonical operational record (tasks + append-only
// task_events) but it lives OUTSIDE the repository, so anyone reading the repo
// cannot see what work happened or why. This script closes that gap: every
// completed task becomes one journal entry under docs/journal/.
//
// Properties:
//   * idempotent — existing entries are never rewritten (history is append-only)
//   * read-only against the board (opened with mode=ro)
//   * dependency-free (node:sqlite, no npm install required)
//   * safe to run anywhere — reports cleanly when the board is unreachable
//
// Usage:
//   node scripts/substrate-journal-sync.mjs                       # sync board "smartware"
//   node scripts/substrate-journal-sync.mjs --board <slug>
//   node scripts/substrate-journal-sync.mjs --db /path/kanban.db
//   node scripts/substrate-journal-sync.mjs --dry-run
//
// Run it from cron (see Control Room ADR 0003) so completions land in the repo
// without anyone remembering to do it.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const DRY = argv.includes("--dry-run");
const BOARD = flag("--board", process.env.KANBAN_BOARD || "smartware");
const DB = flag("--db", process.env.KANBAN_BOARD_DB || `/opt/data/kanban/boards/${BOARD}/kanban.db`);
const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const JOURNAL = join(ROOT, "docs", "journal");

if (!existsSync(DB)) {
  console.log(`journal:sync — board database not reachable (${DB}); nothing to do.`);
  process.exit(0);
}

let DatabaseSync;
try {
  DatabaseSync = createRequire(import.meta.url)("node:sqlite").DatabaseSync;
} catch {
  console.error("journal:sync — node:sqlite unavailable (needs Node >= 22.5 with --experimental-sqlite, or >= 23).");
  process.exit(1);
}

const db = new DatabaseSync(`file:${DB}?mode=ro`);
const all = (sql, ...p) => db.prepare(sql).all(...p);

// `select *` rather than an explicit column list: the board schema is owned by
// Hermes and gains columns between releases. This sync must not break when it
// does — ADR 0003 rule 7 (generators degrade, never break).
const tasks = all(
  "select * from tasks where status = 'done' and completed_at is not null order by completed_at"
);

const iso = (epoch) => new Date(epoch * 1000).toISOString();
const yamlStr = (s) => JSON.stringify(String(s ?? ""));

function completion(taskId) {
  const ev = all(
    "select payload from task_events where task_id = ? and kind = 'completed' order by id desc limit 1",
    taskId
  )[0];
  let summary = "", artifacts = [];
  if (ev?.payload) {
    try {
      const p = JSON.parse(ev.payload);
      summary = p.summary || "";
      artifacts = Array.isArray(p.artifacts) ? p.artifacts.map(String) : [];
    } catch { /* payload not JSON — fall through */ }
  }
  const comments = all("select author, body, created_at from task_comments where task_id = ? order by created_at", taskId);
  const claimed = all("select payload from task_events where task_id = ? and kind in ('claimed','spawned','assigned') and payload is not null", taskId);
  const actors = new Set();
  for (const c of claimed) {
    try {
      const p = JSON.parse(c.payload || "{}");
      if (p.author) actors.add(p.author);
      if (p.agent) actors.add(p.agent);
    } catch { /* payload not JSON — ignore */ }
  }
  for (const c of comments) actors.add(c.author);
  return { summary, artifacts, comments, actors: [...actors] };
}

if (!existsSync(JOURNAL)) mkdirSync(JOURNAL, { recursive: true });

let written = 0, skipped = 0;
const entries = [];

for (const t of tasks) {
  const date = iso(t.completed_at).slice(0, 10);
  const file = `${date}-${t.id}.md`;
  const path = join(JOURNAL, file);
  entries.push({ file, id: t.id, title: t.title, date, status: t.status });
  if (existsSync(path)) {
    skipped += 1;
    continue;
  }
  const { summary, artifacts, comments, actors } = completion(t.id);
  const L = [];
  L.push("---");
  L.push(`task: ${t.id}`);
  L.push(`board: ${BOARD}`);
  L.push(`status: ${t.status}`);
  L.push(`completed: ${iso(t.completed_at)}`);
  L.push(`created: ${iso(t.created_at)}`);
  L.push(`assignee: ${yamlStr(t.assignee || "unassigned")}`);
  L.push(`created_by: ${yamlStr(t.created_by || "")}`);
  L.push(`artifacts: ${JSON.stringify(artifacts)}`);
  L.push("---");
  L.push("");
  L.push(`# ${t.title}`);
  L.push("");
  L.push("## Intent");
  L.push("");
  if (t.body && t.body.trim()) {
    L.push(t.body.trim().split("\n").map((l) => (l.trim() ? l : "")).join("\n"));
  } else {
    L.push("_(no task body recorded)_");
  }
  L.push("");
  L.push("## Resulting state");
  L.push("");
  L.push(summary ? summary.trim() : "_(no completion summary recorded on the board)_");
  L.push("");
  if (artifacts.length) {
    L.push("**Artifacts recorded:**");
    L.push("");
    for (const a of artifacts) L.push(`- \`${a}\``);
    L.push("");
  }
  if (comments.length) {
    L.push("## Recorded notes");
    L.push("");
    for (const c of comments) {
      L.push(`- **${c.author}** (${iso(c.created_at).slice(0, 16).replace("T", " ")}Z): ${String(c.body).trim().replace(/\n+/g, " ").slice(0, 400)}`);
    }
    L.push("");
  }
  L.push("## Provenance");
  L.push("");
  L.push(`- Canonical record: kanban board \`${BOARD}\`, task \`${t.id}\` (\`task_events\` append-only log).`);
  L.push(`- Actors recorded: ${actors.length ? actors.join(", ") : "none recorded"}`);
  L.push(`- Generated by \`scripts/substrate-journal-sync.mjs\` — regenerate the projection, never this entry.`);
  L.push("");
  if (DRY) {
    console.log(`[dry-run] would write docs/journal/${file}`);
  } else {
    writeFileSync(path, L.join("\n"));
    console.log(`wrote docs/journal/${file}`);
  }
  written += 1;
}

// INDEX.md is itself a projection: regenerated on every sync.
const allEntries = readdirSync(JOURNAL)
  .filter((f) => /^\d{4}-\d{2}-\d{2}-.*\.md$/.test(f))
  .sort()
  .map((f) => {
    let title = f;
    try {
      title = (readFileSync(join(JOURNAL, f), "utf8").match(/^#\s+(.+)$/m) || [, f])[1].trim();
    } catch { /* keep filename */ }
    return { f, title, date: f.slice(0, 10) };
  });

const idx = [];
idx.push("<!-- GENERATED — regenerate with `npm run journal:sync`. -->");
idx.push("");
idx.push("# Journal index");
idx.push("");
idx.push("One entry per recorded state transition. Newest last. Entries are append-only:");
idx.push("supersede an earlier entry with a new one, never by editing the old one.");
idx.push("");
idx.push(`Total: **${allEntries.length}** entries.`);
idx.push("");
idx.push("| Date | Entry | Title |");
idx.push("|---|---|---|");
for (const e of allEntries) idx.push(`| ${e.date} | [\`${e.f}\`](${e.f}) | ${e.title.replace(/\|/g, "\\|")} |`);
idx.push("");
if (!DRY) writeFileSync(join(JOURNAL, "INDEX.md"), idx.join("\n"));

console.log(
  `journal:sync board=${BOARD} — ${tasks.length} completed task(s): ${written} written, ${skipped} already present${DRY ? " (dry-run)" : ""}.`
);
