// Observability — storage size and backup freshness (P1-3).
//
// Two filesystem facts a host operator needs during a trial and the brain can
// state without guessing:
//
//   - *how big is this brain, and where did the bytes go?* — a stat walk over
//     the data directory, classified by area. The classification is
//     directory-anchored, not semantical: `canonical` is the JSONL substrate
//     (evidence/, claims/, operations/), `derived` is regenerable projection
//     (indices/, wiki/), `other` is everything else — including the operational
//     SQLite database, which mixes derived indexes with ledgers. The report
//     says that in the field docs rather than pretending the number is pure.
//
//   - *is the newest backup fresh?* — the brain does not create backups and
//     does not know the host's retention policy. It reports what the host's
//     backup directory actually contains: how many entries, the newest entry's
//     timestamp, and its age. "Not configured" is a distinct, honest state.
//
// Neither walk follows symlinks, and both are O(entries). They are computed on
// demand for a health report, never cached, so the numbers cannot go stale.

import fs from 'node:fs';
import path from 'node:path';

export interface StorageReport {
  total_bytes: number;
  files: number;
  by_area: { canonical: number; derived: number; other: number };
}

/** Directory-anchored areas of the data directory. */
const CANONICAL_DIRS = ['evidence', 'claims', 'operations'];
const DERIVED_DIRS = ['indices', 'wiki'];

function areaOf(topLevel: string): keyof StorageReport['by_area'] {
  if (CANONICAL_DIRS.includes(topLevel)) return 'canonical';
  if (DERIVED_DIRS.includes(topLevel)) return 'derived';
  return 'other';
}

/** Sum of regular-file bytes and file count for a directory tree. */
function walk(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // unreadable (permissions, race) — reported as absent, never guessed
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          bytes += fs.statSync(full).size;
          files += 1;
        } catch {
          // disappeared between readdir and stat: not part of the total
        }
      }
    }
  }
  return { bytes, files };
}

export function scanStorage(dataDir: string): StorageReport {
  const byArea = { canonical: 0, derived: 0, other: 0 };
  let files = 0;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dataDir, { withFileTypes: true });
  } catch {
    return { total_bytes: 0, files: 0, by_area: byArea };
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const totals = walk(path.join(dataDir, entry.name));
    byArea[areaOf(entry.name)] += totals.bytes;
    files += totals.files;
  }
  // Top-level files (config.json, smartware.db and its WAL/SHM sidecars) are
  // operational/derived bytes: count them under `other` and in the total.
  let topLevelBytes = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      topLevelBytes += fs.statSync(path.join(dataDir, entry.name)).size;
      files += 1;
    } catch {
      // gone by now
    }
  }
  byArea.other += topLevelBytes;
  const total = byArea.canonical + byArea.derived + byArea.other;
  return { total_bytes: total, files, by_area: byArea };
}

export interface BackupReport {
  /** True when the host pointed health at a backup directory. */
  configured: boolean;
  dir: string | null;
  /** Direct entries (files or directories) in the backup directory. */
  artifacts: number;
  /** Newest direct entry's mtime, ISO 8601 — null when the directory is empty. */
  newest_at: string | null;
  age_seconds: number | null;
}

/**
 * The host owns the backup layout and retention policy; the brain reads the
 * newest directly-contained entry of the directory the host names. A dated
 * directory or a dated file both work: neither is guessed at or reordered.
 */
export function scanBackup(dir: string | undefined, now: Date): BackupReport {
  if (!dir) {
    return { configured: false, dir: null, artifacts: 0, newest_at: null, age_seconds: null };
  }
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { configured: true, dir, artifacts: 0, newest_at: null, age_seconds: null };
  }
  let newest = 0;
  let artifacts = 0;
  for (const entry of entries) {
    try {
      const stat = fs.statSync(path.join(dir, entry.name));
      newest = Math.max(newest, stat.mtimeMs);
      artifacts += 1;
    } catch {
      // disappeared mid-scan
    }
  }
  if (artifacts === 0) {
    return { configured: true, dir, artifacts: 0, newest_at: null, age_seconds: null };
  }
  const newestAt = new Date(newest);
  return {
    configured: true,
    dir,
    artifacts,
    newest_at: newestAt.toISOString(),
    age_seconds: Math.max(0, Math.round((now.getTime() - newest) / 1000)),
  };
}
