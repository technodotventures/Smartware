// Private filesystem writes — the durable (atomic + fsync) variant.
//
// Why this file exists: `saveConfig` writes config.json through
// `writePrivateFileDurable` because a torn or lost config write creates
// divergences the substrate cannot distinguish from real state (card
// t_7a64ded2, finding F2). These tests pin the observable properties of the
// primitive: content, privacy mode, no residue, and — when the rename cannot
// complete — a destination that is left exactly as it was.

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writePrivateFileDurable } from '../../src/storage/private-fs.js';

describe('writePrivateFileDurable', () => {
  const dirs: string[] = [];

  function scratchDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-private-fs-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('writes content privately and leaves no temp residue', () => {
    const dir = scratchDir();
    const target = path.join(dir, 'config.json');

    writePrivateFileDurable(target, '{"a":1}\n', 'utf-8');

    expect(fs.readFileSync(target, 'utf8')).toBe('{"a":1}\n');
    if (process.platform !== 'win32') {
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    }
    // The hidden temp file must not survive a successful commit.
    expect(fs.readdirSync(dir)).toEqual(['config.json']);
  });

  it('replaces an existing destination wholesale', () => {
    const dir = scratchDir();
    const target = path.join(dir, 'config.json');

    writePrivateFileDurable(target, 'old-and-longer-content', 'utf-8');
    writePrivateFileDurable(target, 'new', 'utf-8');

    expect(fs.readFileSync(target, 'utf8')).toBe('new');
    expect(fs.readdirSync(dir)).toEqual(['config.json']);
  });

  it('leaves the destination untouched when the write cannot be committed', () => {
    const dir = scratchDir();
    // rename(2) onto a non-empty directory fails — a deterministic stand-in
    // for "this write could not be committed". The destination must keep its
    // old state and the temp file must be cleaned up.
    const target = path.join(dir, 'config.json');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');

    expect(() => writePrivateFileDurable(target, '{"a":1}\n', 'utf-8')).toThrow();

    expect(fs.statSync(target).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8')).toBe('keep');
    expect(fs.readdirSync(dir)).toEqual(['config.json']);
  });
});
