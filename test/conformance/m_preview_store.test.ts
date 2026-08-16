// Conformance Suite M — Preview Store (§9)
// TTL expiration, consumption, drift detection, restart survival.

import { describe, it, expect } from 'vitest';
import { CascadePreviewStore } from '../../src/preview_store/store.js';

describe('Preview Store', () => {
  it('M1: preview_expires_after_ttl', () => {
    const store = new CascadePreviewStore(':memory:', 0);
    const id = store.put({ page_id: 'page_test', sources_snapshot: [], shared_claims_snapshot: [] });
    const result = store.lookup(id);
    expect(result.kind).toBe('expired');
    store.close();
  });

  it('M2: consumed_preview_is_not_replayable', () => {
    const store = new CascadePreviewStore(':memory:');
    const id = store.put({ page_id: 'page_test', sources_snapshot: [], shared_claims_snapshot: [] });
    expect(store.consume(id)).toBe(true);
    const result = store.lookup(id);
    expect(result.kind).toBe('consumed');
    store.close();
  });

  it('M3: drift_detected_on_stale_preview', () => {
    const store = new CascadePreviewStore(':memory:');
    const id = store.put({
      page_id: 'page_test',
      sources_snapshot: ['claim_a', 'claim_b'],
      shared_claims_snapshot: ['claim_a'],
    });
    const lookup = store.lookup(id);
    expect(lookup.kind).toBe('hit');
    if (lookup.kind === 'hit') {
      const currentSources = ['claim_a', 'claim_c'];
      const drifted = JSON.stringify(currentSources) !== JSON.stringify(lookup.payload.sources_snapshot);
      expect(drifted).toBe(true);
    }
    store.close();
  });

  it('M4: preview_survives_restart', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-preview-'));
    const dbPath = path.join(tmpDir, 'preview.db');

    const store1 = new CascadePreviewStore(dbPath);
    const id = store1.put({ page_id: 'page_test', sources_snapshot: ['claim_a'], shared_claims_snapshot: [] });
    store1.close();

    const store2 = new CascadePreviewStore(dbPath);
    const result = store2.lookup(id);
    expect(result.kind).toBe('hit');
    store2.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
