#!/usr/bin/env node
// substrate-status.mjs — regenerate docs/STATUS.md from canonical sources.
//
// Design rule: DERIVE what can be derived, DECLARE only what cannot, and mark
// declared facts STALE when they age out. Nothing in STATUS.md should be a
// hand-copied fact that a machine could have computed.
//
// Usage:
//   node scripts/substrate-status.mjs            # write docs/STATUS.md
//   node scripts/substrate-status.mjs --stdout   # print instead of writing
//   node scripts/substrate-status.mjs --check    # exit 1 if docs/STATUS.md is stale
//
// Env:
//   KANBAN_BOARD     board slug (default: "smartware")
//   KANBAN_BOARD_DB  explicit path to the kanban sqlite file (overrides slug)
//
// The kanban board is an OPTIONAL source: it lives outside the repository and
// is not reachable from every environment (CI, a fresh clone). When it is
// unavailable the operational sections degrade to an explicit "not reachable"
// note rather than silently omitting.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, basename } from "node:path";

const args = process.argv.slice(2);
const MODE = args.includes("--check") ? "check" : args.includes("--stdout") ? "stdout" : "write";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const BOARD_SLUG = process.env.KANBAN_BOARD || "smartware";

// ---------------------------------------------------------------- git helpers
function git(...a) {
  try {
    return execFileSync("git", a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}
const hasRef = (ref) => git("rev-parse", "--verify", "--quiet", ref + "^{commit}") !== "";

// ------------------------------------------------------------------- file read
function readJSON(p, fallback = null) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; }
}
function firstHeading(path) {
  try {
    const m = readFileSync(path, "utf8").match(/^#\s+(.+)$/m);
    return m ? m[1].trim() : basename(path);
  } catch { return basename(path); }
}
function field(path, label) {
  try {
    const re = new RegExp("^\\*\\*" + label + ":\\*\\*\\s*(.+)$", "m");
    const m = readFileSync(path, "utf8").match(re);
    return m ? m[1].trim() : "";
  } catch { return ""; }
}

const pkg = readJSON(join(ROOT, "package.json"), {});
const declared = readJSON(join(ROOT, "docs", "substrate.json"), {});

// ---------------------------------------------------------------------- state
const branch = git("rev-parse", "--abbrev-ref", "HEAD") || "(detached)";
const headSha = git("rev-parse", "--short", "HEAD") || "unknown";
const headDate = git("show", "-s", "--format=%cI", "HEAD") || "unknown";
const headSubject = git("show", "-s", "--format=%s", "HEAD") || "unknown";
const dirty = git("status", "--porcelain").split("\n").filter(Boolean);

const TRUNK = ["main", "origin/main"].find(hasRef) || "";
let ahead = "", behind = "", inFlight = [];
if (TRUNK) {
  const lr = git("rev-list", "--left-right", "--count", `${TRUNK}...HEAD`).split(/\s+/);
  behind = lr[0] || "?"; ahead = lr[1] || "?";
  inFlight = git("for-each-ref", "--format=%(refname:short)|%(committerdate:short)|%(subject)", "refs/heads")
    .split("\n").filter(Boolean)
    .map((line) => {
      const [name, date, ...rest] = line.split("|");
      return { name, date, subject: rest.join("|") };
    })
    .filter((b) => b.name !== "main" && b.name !== branch)
    .map((b) => {
      const cnt = git("rev-list", "--count", `${TRUNK}..${b.name}`) || "0";
      return { ...b, ahead: cnt };
    })
    .filter((b) => Number(b.ahead) > 0)
    .sort((a, b) => Number(b.ahead) - Number(a.ahead));
}

// newest spec / protocol versions from filenames
const listFiles = (dir) => (existsSync(join(ROOT, dir)) ? readdirSync(join(ROOT, dir)) : []);
const specFile = listFiles("docs/spec").filter((f) => f.startsWith("smartware-spec-")).sort().pop();
const protoFile = listFiles("docs/protocol").filter((f) => f.startsWith("smartware-protocol-")).sort().pop();
const schemaVersions = listFiles("schemas").sort();

// ADRs
const adrDir = join(ROOT, "docs", "adr");
const adrs = (existsSync(adrDir) ? readdirSync(adrDir) : [])
  .filter((f) => /^\d{4}-.*\.md$/.test(f))
  .sort()
  .map((f) => ({
    file: f,
    num: f.slice(0, 4),
    title: firstHeading(join(adrDir, f)),
    status: field(join(adrDir, f), "Status") || "(no status line)",
    date: field(join(adrDir, f), "Date") || "",
  }));

// journal
const journalDir = join(ROOT, "docs", "journal");
const journal = (existsSync(journalDir) ? readdirSync(journalDir) : [])
  .filter((f) => /^\d{4}-\d{2}-\d{2}-.*\.md$/.test(f))
  .sort()
  .map((f) => ({ file: f, date: f.slice(0, 10), title: firstHeading(join(journalDir, f)) }));
const newestJournal = journal[journal.length - 1];

// ------------------------------------------------------------ kanban (optional)
function loadBoard() {
  const dbPath = process.env.KANBAN_BOARD_DB || `/opt/data/kanban/boards/${BOARD_SLUG}/kanban.db`;
  if (!existsSync(dbPath)) return { ok: false, reason: `board database not found at ${dbPath}` };
  let DatabaseSync;
  try {
    // node:sqlite is built in on Node >= 22.5 (flagged) / >= 23 (unflagged) and
    // removes any dependency on better-sqlite3 for this read-only projection.
    DatabaseSync = createRequire(import.meta.url)("node:sqlite").DatabaseSync;
  } catch {
    return { ok: false, reason: "node:sqlite unavailable in this Node build (needs Node >= 22.5 with --experimental-sqlite, or >= 23)" };
  }
  try {
    const db = new DatabaseSync(`file:${dbPath}?mode=ro`);
    const q = (sql) => db.prepare(sql).all();
    const tasks = q("select id, title, status, assignee, created_at, completed_at, last_heartbeat_at from tasks order by created_at");
    const eventCount = db.prepare("select count(*) n from task_events").get().n;
    const journaled = new Set(journal.map((j) => j.file.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.md$/, "")));
    return { ok: true, dbPath, tasks, eventCount, journaled };
  } catch (e) {
    return { ok: false, reason: `could not read board: ${e.message}` };
  }
}
const board = loadBoard();

const day = (epoch) => (epoch ? new Date(epoch * 1000).toISOString().slice(0, 10) : "—");
const NOW = Math.floor(Date.now() / 1000);

// -------------------------------------------------------------- derived health
const health = [];
const declaredAge = declared.declared_at
  ? Math.floor((Date.now() - Date.parse(declared.declared_at)) / 86400000)
  : null;
const staleLimit = declared.stale_after_days ?? 21;
const declaredStale = declaredAge === null ? true : declaredAge > staleLimit;

// The working tree's cleanliness is deliberately NOT part of the rendered file:
// the commit that lands this file always changes it, which would make the
// projection permanently self-invalidating. It is printed to the console instead.
const envNote = dirty.length === 0
  ? "working tree clean"
  : `working tree dirty (${dirty.length} path${dirty.length === 1 ? "" : "s"})`;
health.push({ ok: !declaredStale, label: declaredStale ? `declared block is STALE (${declaredAge === null ? "no declared_at" : declaredAge + "d old"}, limit ${staleLimit}d)` : `declared block fresh (${declaredAge}d old)` });
health.push({ ok: board.ok, label: board.ok ? `kanban board readable (${board.tasks.length} tasks, ${board.eventCount} events)` : `kanban board not reachable — ${board.reason}` });

let unjournaled = 0, blocked = [], ready = [], claimed = [];
if (board.ok) {
  const done = board.tasks.filter((t) => t.status === "done");
  unjournaled = done.filter((t) => !board.journaled.has(t.id)).length;
  blocked = board.tasks.filter((t) => t.status === "blocked");
  ready = board.tasks.filter((t) => ["ready", "todo", "triage"].includes(t.status));
  claimed = board.tasks.filter((t) => t.status === "claimed" || t.status === "in_progress");
  if (unjournaled === 0) health.push({ ok: true, label: "every completed task has a journal entry" });
  else health.push({ ok: false, label: `${unjournaled} completed task(s) have no journal entry — run: npm run journal:sync` });
  if (blocked.length) health.push({ ok: false, label: `${blocked.length} blocked task(s)` });
  const staleReady = ready.filter((t) => NOW - t.created_at > 14 * 86400);
  if (staleReady.length) health.push({ ok: false, label: `${staleReady.length} queued task(s) older than 14 days` });
}
const proposedAdrs = adrs.filter((a) => /proposed/i.test(a.status));

// ------------------------------------------------------------------- render
const L = [];
L.push("<!-- GENERATED FILE — DO NOT EDIT BY HAND.");
L.push("     Regenerate: npm run status   (node scripts/substrate-status.mjs)");
L.push("     Staleness:  npm run status:check (fails when this file is stale — run in a");
L.push("     working checkout that has git refs; it is not a CI job for that reason)");
L.push("     Derived from: git, package.json, docs/spec, docs/protocol, docs/adr,");
L.push("     docs/journal, docs/substrate.json and (where reachable) the kanban board. -->");
L.push("");
L.push("# STATUS — current operational state");
L.push("");
L.push("> This is a *projection*, not a source of truth. Every line is regenerated from");
L.push("> canonical state; if it disagrees with a canonical source, this file is wrong.");
L.push("> A fresh agent should be able to read this file alone and know where the project is.");
L.push("");
// NOTE: deliberately no ahead/behind count for the CURRENT branch. That number
// changes with every commit, so the projection would invalidate itself on the very
// commit that lands it. Divergence of *other* branches is real information and lives
// in the In-flight table below; the current branch's position is `git log`'s job.
L.push(`**Branch:** \`${branch}\` · **Trunk:** \`${TRUNK || "none"}\`${TRUNK && behind !== "0" ? ` (trunk has moves this tree does not — run \`git log ${TRUNK}..HEAD\` / \`git log HEAD..${TRUNK}\`)` : ""}`);
L.push(`**Version:** ${pkg.version ?? "?"} · **Spec:** ${specFile || "none"} · **Protocol:** ${protoFile || "none"} · **Schemas:** ${schemaVersions.join(", ") || "none"}`);
L.push("");
L.push("## Declared (human-owned; the only non-derived block)");
L.push("");
if (declaredStale) {
  L.push(`> ⚠️ **STALE** — declared ${declaredAge === null ? "at an unknown date" : `${declaredAge} days ago`} (limit ${staleLimit}d). Re-validate \`docs/substrate.json\` before trusting the lines below.`);
  L.push("");
}
L.push(`- **Mission:** ${declared.mission ?? "— not declared"}`);
L.push(`- **Phase:** ${declared.phase ?? "— not declared"}`);
L.push(`- **Owner:** ${declared.owner ?? "— not declared"}`);
L.push(`- **Next action (declared):** ${declared.next_action ?? "— not declared"}`);
L.push(`- Declared: ${declared.declared_at ?? "—"} · source: \`docs/substrate.json\``);
L.push("");
L.push("## Latest material change");
L.push("");
if (newestJournal) L.push(`- **Journal:** [\`${newestJournal.file}\`](journal/${newestJournal.file}) — ${newestJournal.title} (${newestJournal.date})`);
L.push(`- **Journal entries:** ${journal.length}${board.ok ? ` · tasks completed on board \`${BOARD_SLUG}\`: ${board.tasks.filter((t) => t.status === "done").length}` : ""}`);
L.push(`- Commit-level history is deliberately NOT duplicated here — see \`git log\`. This projection tracks operational state, not the commit stream.`);
L.push("");
L.push("## In flight");
L.push("");
if (inFlight.length === 0) L.push("- No local branches ahead of trunk.");
else {
  L.push("| Branch | Ahead | Last commit | Subject |");
  L.push("|---|---|---|---|");
  for (const b of inFlight) L.push(`| \`${b.name}\` | ${b.ahead} | ${b.date} | ${b.subject.replace(/\|/g, "\\|")} |`);
  L.push("");
  L.push("Unmerged work — read the branch before assuming this tree is current.");
}
if (claimed.length) {
  L.push("");
  L.push("**Claimed/executing now:**");
  for (const t of claimed) L.push(`- \`${t.id}\` ${t.title} (heartbeat ${day(t.last_heartbeat_at)})`);
}
L.push("");
L.push("## Queued / next up");
L.push("");
if (!board.ok) L.push(`- Board not reachable from this environment (${board.reason}). Canonical queue: the kanban board \`${BOARD_SLUG}\`.`);
else if (ready.length === 0) L.push("- Queue empty.");
else for (const t of ready) L.push(`- \`${t.id}\` [${t.status}] ${t.title} (created ${day(t.created_at)}${t.assignee ? `, assignee ${t.assignee}` : ", unassigned"})`);
L.push("");
L.push("## Blockers and stale work");
L.push("");
if (!board.ok) L.push("- Board not reachable — cannot verify blockers from here.");
else if (blocked.length === 0) L.push("- No blocked tasks on the board.");
else for (const t of blocked) L.push(`- \`${t.id}\` ${t.title}`);
L.push("");
L.push("## Decisions");
L.push("");
if (adrs.length === 0) L.push("- No ADRs in this tree yet (see `docs/adr/README.md`).");
else {
  L.push("| ADR | Title | Status | Date |");
  L.push("|---|---|---|---|");
  for (const a of adrs) L.push(`| [${a.num}](adr/${a.file}) | ${a.title.replace(/^ADR\s*\d+\s*[—-]\s*/, "").replace(/\|/g, "\\|")} | ${a.status} | ${a.date} |`);
  if (proposedAdrs.length) {
    L.push("");
    L.push(`**Pending decision:** ${proposedAdrs.map((a) => `${a.num} (${a.title})`).join(", ")}`);
  }
}
if (Array.isArray(declared.open_questions) && declared.open_questions.length) {
  L.push("");
  L.push("**Open questions (declared):**");
  for (const q of declared.open_questions) L.push(`- ${q}`);
}
if (Array.isArray(declared.approvals_pending) && declared.approvals_pending.length) {
  L.push("");
  L.push("**Approvals pending (declared):**");
  for (const a of declared.approvals_pending) L.push(`- ${a}`);
}
L.push("");
L.push("## Verification state");
L.push("");
L.push("- **Acceptance criteria + exact commands:** [`VERIFY.md`](../VERIFY.md) — the definition of done for this repo.");
L.push("- **CI gate:** `.github/workflows/ci.yml` (Node 22 + 24 matrix; `npm ci`, prod-vulnerability rejection, build, tests).");
L.push("- **Adjacent status projections:** " + [
  ["conformance-status.md", "docs/conformance-status.md"],
  ["dream-status.md", "docs/dream-status.md"],
  ["security-audit.md", "docs/security-audit.md"],
].filter(([, p]) => existsSync(join(ROOT, p))).map(([n]) => `[\`${n}\`](${n})`).join(" · "));
L.push("- **Last recorded gate evidence:** see the newest journal entry (each entry carries the commands run and their output).");
L.push("");
L.push("## Health");
L.push("");
for (const h of health) L.push(`- ${h.ok ? "✅" : "⚠️"} ${h.label}`);
L.push("");
L.push("## Canonical index");
L.push("");
L.push("| Question | Source |");
L.push("|---|---|");
L.push("| What is this project for? | [`README.md`](../README.md) |");
L.push("| What must the code do (normative)? | " + (specFile ? `[\`docs/spec/${specFile}\`](spec/${specFile})` : "—") + " |");
L.push("| What is the wire contract? | " + (protoFile ? `[\`docs/protocol/${protoFile}\`](protocol/${protoFile})` : "—") + " |");
L.push("| Why is it built this way? | [`docs/adr/`](adr/) |");
L.push("| What work happened? | [`docs/journal/`](journal/) |");
L.push("| How do I know a change is acceptable? | [`VERIFY.md`](../VERIFY.md) |");
L.push("| What is queued or blocked? | kanban board `" + BOARD_SLUG + "` (operational record, outside this repo) |");
L.push("| How do I operate in this repo? | [`AGENTS.md`](../AGENTS.md) |");
L.push("");
L.push(`_Projection generated by \`scripts/substrate-status.mjs\` from the canonical sources listed under "Canonical index"._`);
L.push("");

const out = L.join("\n");

// --------------------------------------------------------------------- modes
if (MODE === "stdout") {
  process.stdout.write(out);
  process.exit(0);
}
const target = join(ROOT, "docs", "STATUS.md");
// --check ignores facts that are environmental rather than stateful: the working
// tree's cleanliness at generation time (the commit that lands this file always
// changes it). Everything else must match exactly or the projector is stale.
const normalize = (s) =>
  s
    .replace(/^.*working tree (clean|dirty) at generation time.*$/gm, "ENV:working-tree")
    .replace(/_Generated from tree .*_/g, "_Generated from tree X_");
if (MODE === "check") {
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (normalize(current) !== normalize(out)) {
    console.error("STATUS.md is STALE — regenerate with: node scripts/substrate-status.mjs");
    process.exit(1);
  }
  console.log("STATUS.md is current.");
  process.exit(0);
}
writeFileSync(target, out);
console.log(`wrote ${target} (${out.split("\n").length} lines, tree ${headSha} on ${branch}; ${envNote})`);
