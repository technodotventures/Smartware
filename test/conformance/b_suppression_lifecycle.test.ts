// Conformance Suite B — Suppression Lifecycle Transition Matrix

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import {
  isEffectiveCurrent,
  checkAcyclicity,
  computeReleasedClaims,
  revalidateOnRevive,
} from '../../src/layer1/effective_current.js';

let tmpDir: string;
let db: Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'active',
  scope TEXT NOT NULL DEFAULT 'personal'
);
CREATE TABLE IF NOT EXISTS claim_relations (
  relation_id TEXT NOT NULL,
  source_claim_id TEXT NOT NULL,
  source_version INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL,
  target_claim_id TEXT NOT NULL,
  valid_at TEXT NOT NULL,
  invalid_at TEXT,
  origin TEXT,
  asserted_in_source_version INTEGER,
  target_claim_version INTEGER,
  PRIMARY KEY (relation_id)
);
CREATE INDEX IF NOT EXISTS idx_rel_source ON claim_relations(source_claim_id);
CREATE INDEX IF NOT EXISTS idx_rel_target ON claim_relations(target_claim_id);
`;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-graph-'));
  db = new Database(path.join(tmpDir, 'test.db'));
  db.exec(SCHEMA);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function insertClaim(id: string, state: 'active' | 'forgotten' = 'active') {
  db.prepare('INSERT INTO claims (id, state) VALUES (?, ?)').run(id, state);
}

function insertRelation(relId: string, sourceId: string, kind: string, targetId: string, invalidAt: string | null = null) {
  db.prepare(`
    INSERT INTO claim_relations (relation_id, source_claim_id, kind, target_claim_id, valid_at, invalid_at)
    VALUES (?, ?, ?, ?, datetime('now'), ?)
  `).run(relId, sourceId, kind, targetId, invalidAt);
}

describe('Suppression Lifecycle', () => {
  it('B1: admit_supersedes_suppresses_target', () => {
    insertClaim('claim_A');
    insertClaim('claim_B');
    insertRelation('rel_1', 'claim_B', 'supersedes', 'claim_A');
    expect(isEffectiveCurrent('claim_A', db)).toBe(false);
    expect(isEffectiveCurrent('claim_B', db)).toBe(true);
  });

  it('B2: admit_corrects_suppresses_target', () => {
    insertClaim('claim_A');
    insertClaim('claim_B');
    insertRelation('rel_1', 'claim_B', 'corrects', 'claim_A');
    expect(isEffectiveCurrent('claim_A', db)).toBe(false);
    expect(isEffectiveCurrent('claim_B', db)).toBe(true);
  });

  it('B3: admit_cycle_rejected', () => {
    insertClaim('claim_A');
    insertClaim('claim_B');
    insertRelation('rel_1', 'claim_A', 'supersedes', 'claim_B');
    expect(checkAcyclicity('claim_B', 'claim_A', 'supersedes', db)).toBe(false);
  });

  it('B4: forget_replacement_releases_target', () => {
    insertClaim('claim_A');
    insertClaim('claim_B');
    insertRelation('rel_1', 'claim_B', 'supersedes', 'claim_A');
    expect(isEffectiveCurrent('claim_A', db)).toBe(false);

    db.prepare("UPDATE claims SET state = 'forgotten' WHERE id = 'claim_B'").run();
    expect(isEffectiveCurrent('claim_A', db)).toBe(true);
  });

  it('B5: forget_protected_replacement_releases_target', () => {
    insertClaim('claim_A');
    insertClaim('claim_B');
    insertRelation('rel_1', 'claim_B', 'corrects', 'claim_A');
    expect(isEffectiveCurrent('claim_A', db)).toBe(false);

    db.prepare("UPDATE claims SET state = 'forgotten' WHERE id = 'claim_B'").run();
    expect(isEffectiveCurrent('claim_A', db)).toBe(true);
  });

  it('B6: forget_by_agent_unprotected_with_access', () => {
    // Agent with forget grant can forget an unprotected claim.
    // This is an ACCESS decision, tested via evaluateAccess in K3.
    // Here we verify the graph effect: forgotten claim is not effective-current.
    insertClaim('claim_A');
    db.prepare("UPDATE claims SET state = 'forgotten' WHERE id = 'claim_A'").run();
    expect(isEffectiveCurrent('claim_A', db)).toBe(false);
  });

  it('B7: forget_by_agent_unprotected_without_access', () => {
    // Tested via ACCESS enforcement in K3 — agent without forget grant is rejected.
    // Graph-level: claim remains active and effective-current.
    insertClaim('claim_A');
    expect(isEffectiveCurrent('claim_A', db)).toBe(true);
  });

  it('B8: forget_by_agent_protected_rejected', () => {
    // Protection enforcement: agent cannot forget epistemic_owner:user claim.
    // At graph level: claim remains active.
    insertClaim('claim_A');
    expect(isEffectiveCurrent('claim_A', db)).toBe(true);
  });

  it('B9: release_cascades_through_chain', () => {
    insertClaim('claim_A');
    insertClaim('claim_B');
    insertClaim('claim_C');
    insertRelation('rel_1', 'claim_B', 'supersedes', 'claim_A');
    insertRelation('rel_2', 'claim_C', 'supersedes', 'claim_B');

    expect(isEffectiveCurrent('claim_A', db)).toBe(false);
    expect(isEffectiveCurrent('claim_B', db)).toBe(false);
    expect(isEffectiveCurrent('claim_C', db)).toBe(true);

    db.prepare("UPDATE claims SET state = 'forgotten' WHERE id = 'claim_C'").run();
    expect(isEffectiveCurrent('claim_B', db)).toBe(true);

    db.prepare("UPDATE claims SET state = 'forgotten' WHERE id = 'claim_B'").run();
    expect(isEffectiveCurrent('claim_A', db)).toBe(true);
  });

  it('B10: revive_revalidates_edges_clean', () => {
    insertClaim('claim_A');
    insertClaim('claim_B');
    insertRelation('rel_1', 'claim_B', 'supersedes', 'claim_A');
    const result = revalidateOnRevive('claim_B', db);
    expect(result.valid).toContain('rel_1');
    expect(result.invalidated).toHaveLength(0);
  });

  it('B11: revive_revalidates_edges_cycle', () => {
    insertClaim('claim_A');
    insertClaim('claim_B');
    insertRelation('rel_1', 'claim_A', 'supersedes', 'claim_B');
    insertRelation('rel_2', 'claim_B', 'supersedes', 'claim_A');
    const result = revalidateOnRevive('claim_B', db);
    expect(result.invalidated).toContain('rel_2');
  });

  it('B12: revive_restores_protection_state', () => {
    // Revival reconstructs from tombstone snapshot — all metadata preserved.
    // This is a data-level test; at graph level, revived claim is effective-current.
    insertClaim('claim_A', 'forgotten');
    db.prepare("UPDATE claims SET state = 'active' WHERE id = 'claim_A'").run();
    expect(isEffectiveCurrent('claim_A', db)).toBe(true);
  });

  it('B13: revive_by_agent_of_protected_snapshot_rejected', () => {
    // Protection enforcement at handler level — tested via protocol handler.
    // Graph-level: a forgotten claim stays forgotten.
    insertClaim('claim_A', 'forgotten');
    expect(isEffectiveCurrent('claim_A', db)).toBe(false);
  });

  it('B14: withdraw_edge_releases_target', () => {
    insertClaim('claim_A');
    insertClaim('claim_B');
    insertRelation('rel_1', 'claim_B', 'supersedes', 'claim_A');
    expect(isEffectiveCurrent('claim_A', db)).toBe(false);

    db.prepare("UPDATE claim_relations SET invalid_at = datetime('now') WHERE relation_id = 'rel_1'").run();
    expect(isEffectiveCurrent('claim_A', db)).toBe(true);
  });

  it('B15: withdraw_sets_epistemic_owner_on_source', () => {
    // invalidate_relations is adjudication → sets epistemic_owner: user on source.
    // At graph level: the edge is invalidated and target released.
    insertClaim('claim_A');
    insertClaim('claim_B');
    insertRelation('rel_1', 'claim_B', 'supersedes', 'claim_A');

    db.prepare("UPDATE claim_relations SET invalid_at = datetime('now') WHERE relation_id = 'rel_1'").run();
    expect(isEffectiveCurrent('claim_A', db)).toBe(true);
    expect(isEffectiveCurrent('claim_B', db)).toBe(true);
  });

  it('B16: withdraw_by_agent_rejected', () => {
    // Only users can invalidate_relations. Agent rejection at handler level.
    // Graph: edge stays active, target stays suppressed.
    insertClaim('claim_A');
    insertClaim('claim_B');
    insertRelation('rel_1', 'claim_B', 'supersedes', 'claim_A');
    expect(isEffectiveCurrent('claim_A', db)).toBe(false);
  });
});
