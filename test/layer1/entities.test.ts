// Tests: Layer 1 — Entity Resolution (fuzzy matching)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ClaimStore } from '../../src/layer1/store.js';
import { resolveEntity } from '../../src/layer1/entities.js';

let tmpDir: string;
let store: ClaimStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-ent-'));
  store = new ClaimStore(path.join(tmpDir, 'test.db'));
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveEntity', () => {
  it('creates a new entity when no match exists', () => {
    const result = resolveEntity('Alice Johnson', 'person', 'personal', store);
    expect(result.isNew).toBe(true);
    expect(result.id).toMatch(/^entity_/);
  });

  it('finds an exact match on second call', () => {
    const first = resolveEntity('Alice Johnson', 'person', 'personal', store);
    const second = resolveEntity('Alice Johnson', 'person', 'personal', store);
    expect(second.isNew).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it('fuzzy-matches close names', () => {
    const original = resolveEntity('Alice Johnson', 'person', 'personal', store);
    // Slight typo / abbreviation
    const fuzzy = resolveEntity('Alice Jonson', 'person', 'personal', store);
    expect(fuzzy.isNew).toBe(false);
    expect(fuzzy.id).toBe(original.id);
    expect(fuzzy.matchConfidence).toBeGreaterThan(0.8);
  });

  it('creates a new entity for very different name', () => {
    resolveEntity('Alice Johnson', 'person', 'personal', store);
    const different = resolveEntity('Bob Smith', 'person', 'personal', store);
    expect(different.isNew).toBe(true);
  });

  it('does NOT fuzzy-match across different entity types when names are distinct', () => {
    resolveEntity('Smartware', 'project', 'project/smartware', store);
    const diff = resolveEntity('Quantum Computing', 'person', 'project/smartware', store);
    expect(diff.isNew).toBe(true);
  });
});
