import type { Claim } from '../src/layer1/types.js';
import { knownTime, nullTime } from '../src/layer1/types.js';
import { ulid } from 'ulid';

export function makeClaim(overrides: Partial<Claim> = {}): Claim {
  const now = new Date().toISOString();
  return {
    id: `claim_${ulid()}`,
    subject_id: `entity_${ulid()}`,
    subject_name: 'Test Entity',
    predicate: 'status_is',
    object: { type: 'text', value: 'active' },
    scope: 'personal',
    validity: { from: now, to: null },
    t_ingested: knownTime(now),
    t_invalidated: nullTime(),
    t_valid_from: knownTime(now),
    t_valid_to: nullTime(),
    source_event_id: `obs_${ulid()}`,
    extraction_event_id: `obs_${ulid()}`,
    supporting_evidence: [`obs_${ulid()}`],
    extraction: {
      method: 'deterministic',
      model: null,
      compiler_version: '0.5.1',
      prompt_hash: null,
      extracted_at: now,
    },
    status: 'active',
    epistemic: 'observed',
    confidence: 0,
    sensitive: false,
    superseded_by: null,
    contested_by: [],
    ...overrides,
  };
}
