// Operations log — JSONL canonical surface (one file per UTC day).
//
// Mirrors the L0 log's file-per-day pattern (vendor/smartware/src/layer0/log.ts)
// for operational consistency. See docs/atomicity.md.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { OPERATION_ID_PATTERN, type OpLogEntry } from './types.js';

function dateToPath(opsDir: string, date: string): string {
  return join(opsDir, `${date}.jsonl`);
}

/** YYYY-MM-DD in UTC for the entry's timestamp. */
export function dayOfTimestamp(iso8601: string): string {
  return iso8601.slice(0, 10);
}

/**
 * Append a single operations-log entry. The entry's `timestamp` decides
 * which day's file it lands in. The entry must satisfy the OperationId
 * pattern; malformed entries throw.
 */
export function appendOpLogEntry(opsDir: string, entry: OpLogEntry): void {
  if (!OPERATION_ID_PATTERN.test(entry.operation_id)) {
    throw new Error(
      `Operations log entry rejected: operation_id '${entry.operation_id}' does not match ${OPERATION_ID_PATTERN}`,
    );
  }
  if (!entry.actor_id || !entry.timestamp || !entry.op) {
    throw new Error('Operations log entry rejected: actor_id, timestamp, and op are required');
  }

  mkdirSync(opsDir, { recursive: true, mode: 0o700 });
  const path = dateToPath(opsDir, dayOfTimestamp(entry.timestamp));
  const fd = openSync(path, 'a', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(entry) + '\n', 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Read every entry for a given UTC date. Returns [] if the file is missing. */
export function readOpLogDay(opsDir: string, date: string): OpLogEntry[] {
  const path = dateToPath(opsDir, date);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line) as OpLogEntry;
      } catch {
        throw new Error(`Malformed JSONL in ${path}:${i + 1}`);
      }
    });
}

/** Iterate every entry across every day's file in chronological order. */
export function* readAllOpLogEntries(opsDir: string): Generator<OpLogEntry> {
  if (!existsSync(opsDir)) return;
  const days = readdirSync(opsDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.replace('.jsonl', ''))
    .sort(); // YYYY-MM-DD sorts lexicographically == chronologically
  for (const day of days) {
    for (const entry of readOpLogDay(opsDir, day)) {
      yield entry;
    }
  }
}

/** Set of every operation_id present in the canonical ops log. */
export function loadCommittedOperationIds(opsDir: string): Set<string> {
  const ids = new Set<string>();
  for (const entry of readAllOpLogEntries(opsDir)) {
    ids.add(entry.operation_id);
  }
  return ids;
}
