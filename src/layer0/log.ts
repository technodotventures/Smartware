// Layer 0 — JSONL append-only evidence log

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Observation } from './types.js';

/** Get the JSONL file path for a given UTC date string (YYYY-MM-DD) */
function dateToPath(evidenceDir: string, date: string): string {
  return join(evidenceDir, `${date}.jsonl`);
}

/** Get today's date as YYYY-MM-DD (UTC) */
export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Append a single observation to the log. NEVER modifies existing lines.
 */
export function appendObservation(evidenceDir: string, obs: Observation): void {
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const path = dateToPath(evidenceDir, todayUTC());
  const fd = openSync(path, 'a', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(obs) + '\n', 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Read all observations from a single day's file.
 */
export function readFile(evidenceDir: string, date: string): Observation[] {
  const path = dateToPath(evidenceDir, date);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
  return lines.map((line, i) => {
    try {
      return JSON.parse(line) as Observation;
    } catch {
      throw new Error(`Malformed JSONL at ${path}:${i + 1}`);
    }
  });
}

/**
 * Read all observations from all JSONL files in chronological order.
 */
export function* readAll(evidenceDir: string): Generator<Observation> {
  if (!existsSync(evidenceDir)) return;
  const files = readdirSync(evidenceDir)
    .filter(f => f.endsWith('.jsonl'))
    .sort(); // lexicographic = chronological for YYYY-MM-DD

  for (const file of files) {
    const date = file.replace('.jsonl', '');
    const obs = readFile(evidenceDir, date);
    for (const o of obs) yield o;
  }
}

/**
 * List all evidence file dates.
 */
export function listDates(evidenceDir: string): string[] {
  if (!existsSync(evidenceDir)) return [];
  return readdirSync(evidenceDir)
    .filter(f => f.endsWith('.jsonl'))
    .sort()
    .map(f => f.replace('.jsonl', ''));
}
