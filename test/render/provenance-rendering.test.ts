// Tests: Coffee provenance-rendering contract (spec §10c)
//
// Oracle behavior (normative strings — changing these changes the product
// contract, not a bug fix):
//   - Attribution renders STAFF-FACING ONLY. Client surface returns no line,
//     no badge, no why-sentence — except an opt-in "From your messages, <date>"
//     citation for client-owned content (never staff/agent identity).
//   - Default-on predicate: unverified/FAILED freshness, stale, contested,
//     low confidence, consequential claim type/tag, recently-changed
//     (version_at within recentDays), or recently-corrected
//     (correctedAt within correctionVisibleDays). Everything else collapses
//     under the "why this answer?" toggle.
//   - FAILED wording whenever compileState === 'failed', even when the hit
//     label is 'unverified' (spec §11.2 failure semantics).

import { describe, expect, it } from 'vitest';

import {
  attributionLine,
  badge,
  DEFAULT_OPTIONS,
  formatMonthDay,
  showAttributionByDefault,
  whySentence,
  type ProvenanceInput,
} from '../../src/render/provenance.js';

const NOW = new Date('2026-08-29T12:00:00Z');

function input(overrides: Partial<ProvenanceInput>): ProvenanceInput {
  return {
    surface: 'staff',
    freshness: 'extracted',
    compileState: 'resolved',
    actorKind: 'person',
    actorDisplay: 'Maya',
    sourceDate: '2026-05-12T09:00:00Z',
    versionAt: '2026-05-12T09:00:00Z',
    claimType: 'finding',
    epistemicTag: 'fact',
    confidence: 'high',
    ...overrides,
  };
}

describe('flagship: "Learned from Maya, May 12; corrected by owner May 13"', () => {
  const hit = input({
    sourceDate: '2026-05-12T09:00:00Z',
    correctedBy: 'owner',
    correctedAt: '2026-05-13T10:00:00Z',
  });

  it('renders the attribution line with correction clause', () => {
    expect(attributionLine(hit)).toBe('From Maya, May 12; corrected by owner May 13');
  });

  it('renders the canonical why-panel sentence', () => {
    expect(whySentence(hit)).toBe('Learned from Maya, May 12; corrected by owner May 13.');
  });

  it('shows by default (recent correction) with no badge', () => {
    const recent = input({
      sourceDate: '2026-08-25T09:00:00Z',
      correctedBy: 'owner',
      correctedAt: '2026-08-26T10:00:00Z',
    });
    expect(showAttributionByDefault(recent, {}, NOW)).toBe(true);
    expect(badge(recent)).toBeNull();
  });
});

describe('default-on predicate (staff surface)', () => {
  it('is true for unverified freshness (state-based, never time-based)', () => {
    expect(showAttributionByDefault(input({ freshness: 'unverified' }), {}, NOW)).toBe(true);
  });

  it('is true for failed freshness', () => {
    expect(showAttributionByDefault(input({ freshness: 'failed' }), {}, NOW)).toBe(true);
  });

  it('is true when compileState is failed even if label is unverified', () => {
    expect(showAttributionByDefault(input({ freshness: 'unverified', compileState: 'failed' }), {}, NOW)).toBe(true);
  });

  it('is true for stale, contested, and low-confidence claims', () => {
    expect(showAttributionByDefault(input({ epistemicTag: 'stale' }), {}, NOW)).toBe(true);
    expect(showAttributionByDefault(input({ epistemicTag: 'contested' }), {}, NOW)).toBe(true);
    expect(showAttributionByDefault(input({ confidence: 'low' }), {}, NOW)).toBe(true);
  });

  it('is true for consequential claim types', () => {
    for (const claimType of ['decision', 'constraint', 'handoff', 'correction'] as const) {
      expect(showAttributionByDefault(input({ claimType }), {}, NOW)).toBe(true);
    }
  });

  it('is true when a tag is consequential', () => {
    expect(showAttributionByDefault(input({ tags: ['price'] }), {}, NOW)).toBe(true);
    expect(showAttributionByDefault(input({ tags: ['quote'] }), {}, NOW)).toBe(true);
  });

  it('is true for recently-changed version_at (within recentDays)', () => {
    expect(
      showAttributionByDefault(input({ versionAt: '2026-08-26T09:00:00Z' }), {}, NOW),
    ).toBe(true);
    expect(
      showAttributionByDefault(input({ versionAt: '2026-08-19T09:00:00Z' }), {}, NOW),
    ).toBe(true);
  });

  it('is false beyond the default 14d recency window for a stable fact', () => {
    expect(
      showAttributionByDefault(input({ versionAt: '2026-08-01T09:00:00Z' }), {}, NOW),
    ).toBe(false);
  });

  it('is true for a correction within correctionVisibleDays regardless of recency', () => {
    expect(
      showAttributionByDefault(input({ versionAt: '2026-01-01T09:00:00Z', correctedAt: '2026-08-20T09:00:00Z' }), {}, NOW),
    ).toBe(true);
  });

  it('is false for stable, old, high-confidence non-consequential facts', () => {
    expect(
      showAttributionByDefault(
        input({ versionAt: '2026-01-01T09:00:00Z', sourceDate: '2026-01-01T09:00:00Z' }),
        {},
        NOW,
      ),
    ).toBe(false);
  });

  it('is false once the correction window passes (default 30 days)', () => {
    expect(
      showAttributionByDefault(
        input({ correctedAt: '2026-07-01T09:00:00Z', claimType: 'finding' }),
        {},
        NOW,
      ),
    ).toBe(false);
  });

  it('honors custom windows', () => {
    const opts = { recentDays: 30, correctionVisibleDays: 90 };
    expect(showAttributionByDefault(input({ versionAt: '2026-08-01T09:00:00Z' }), opts, NOW)).toBe(true);
    expect(showAttributionByDefault(input({ correctedAt: '2026-06-01T09:00:00Z' }), opts, NOW)).toBe(true);
  });

  it('is always false on the client surface', () => {
    const base = input({ surface: 'client', clientOwned: true });
    expect(showAttributionByDefault(base, {}, NOW)).toBe(false);
    expect(showAttributionByDefault(input({ surface: 'client' }), {}, NOW)).toBe(false);
  });
});

describe('freshness wording: unverified / EXTRACTED / FAILED', () => {
  it('unverified: plain source line + "New" badge + filing sentence', () => {
    const hit = input({ freshness: 'unverified' });
    expect(badge(hit)).toBe('New');
    expect(attributionLine(hit)).toBe('From Maya, May 12');
    expect(whySentence(hit)).toBe('Learned from Maya, May 12; still being filed — may change.');
  });

  it('FAILED (label failed): never looks verified, never hidden', () => {
    const hit = input({ freshness: 'failed' });
    expect(badge(hit)).toBe('Not verified');
    expect(attributionLine(hit)).toBe('From Maya, May 12 — not verified');
    expect(whySentence(hit)).toBe(
      "Coffee couldn't verify this automatically; shown as received from Maya on May 12. Review before relying.",
    );
  });

  it('compileState=failed renders FAILED wording even with unverified label', () => {
    const hit = input({ freshness: 'unverified', compileState: 'failed' });
    expect(badge(hit)).toBe('Not verified');
    expect(attributionLine(hit)).toBe('From Maya, May 12 — not verified');
    expect(whySentence(hit)).toBe(
      "Coffee couldn't verify this automatically; shown as received from Maya on May 12. Review before relying.",
    );
  });

  it('EXTRACTED stable fact: no badge, plain line, plain sentence', () => {
    const hit = input({});
    expect(badge(hit)).toBeNull();
    expect(attributionLine(hit)).toBe('From Maya, May 12');
    expect(whySentence(hit)).toBe('Learned from Maya, May 12.');
  });
});

describe('epistemic and confidence wording (staff-facing only)', () => {
  it('agent-authored fact', () => {
    const hit = input({ actorKind: 'agent', actorDisplay: undefined });
    expect(attributionLine(hit)).toBe('From Coffee AI, May 12');
    expect(whySentence(hit)).toBe('Coffee learned this on May 12.');
  });

  it('person inference', () => {
    const hit = input({ epistemicTag: 'inference' });
    expect(attributionLine(hit)).toBe('From Maya, May 12 — inference');
    expect(whySentence(hit)).toBe('Learned from Maya, May 12 — an inference, not stated directly.');
  });

  it('agent inference', () => {
    const hit = input({ actorKind: 'agent', actorDisplay: undefined, epistemicTag: 'inference' });
    expect(attributionLine(hit)).toBe('Inferred by Coffee, May 12');
    expect(whySentence(hit)).toBe("Coffee inferred this on May 12; it wasn't stated directly.");
  });

  it('opinion', () => {
    const hit = input({ epistemicTag: 'opinion' });
    expect(attributionLine(hit)).toBe('From Maya, May 12 — preference');
    expect(whySentence(hit)).toBe('Learned from Maya, May 12 — recorded as a preference, not a fact.');
  });

  it('stale', () => {
    const hit = input({ epistemicTag: 'stale', versionAt: '2026-01-10T09:00:00Z' });
    expect(badge(hit)).toBe('May be stale');
    expect(attributionLine(hit)).toBe('From Maya, May 12');
    expect(whySentence(hit)).toBe('Learned from Maya, May 12. Not updated since January 10.');
  });

  it('contested', () => {
    const hit = input({ epistemicTag: 'contested' });
    expect(badge(hit)).toBe('Conflict');
    expect(whySentence(hit)).toContain('Sources disagree about this.');
  });

  it('low confidence', () => {
    const hit = input({ confidence: 'low' });
    expect(badge(hit)).toBe('Unconfirmed');
    expect(whySentence(hit)).toBe('Learned from Maya, May 12. Low confidence.');
  });
});

describe('client-facing surface: provenance chrome never renders', () => {
  it('client-owned content may cite the client\'s own messages only', () => {
    const hit = input({ surface: 'client', clientOwned: true });
    expect(attributionLine(hit)).toBe('From your messages, May 12');
    expect(badge(hit)).toBeNull();
    expect(whySentence(hit)).toBeNull();
  });

  it('staff/agent attribution never renders for a client', () => {
    const hit = input({ surface: 'client', clientOwned: false });
    expect(attributionLine(hit)).toBeNull();
    expect(badge(hit)).toBeNull();
    expect(whySentence(hit)).toBeNull();
  });

  it('no freshness badge leaks for a client even when unverified', () => {
    const hit = input({ surface: 'client', clientOwned: false, freshness: 'unverified' });
    expect(attributionLine(hit)).toBeNull();
    expect(badge(hit)).toBeNull();
    expect(whySentence(hit)).toBeNull();
  });
});

describe('formatMonthDay', () => {
  it('formats UTC month/day deterministically', () => {
    expect(formatMonthDay('2026-05-12T23:59:59Z')).toBe('May 12');
    expect(formatMonthDay(new Date('2026-01-02T00:00:00Z'))).toBe('January 2');
  });

  it('returns empty string for invalid input', () => {
    expect(formatMonthDay('not-a-date')).toBe('');
    expect(formatMonthDay(undefined)).toBe('');
  });
});

describe('default options', () => {
  it('binds the contract defaults (14d recent, 30d correction, consequential tag set)', () => {
    expect(DEFAULT_OPTIONS.recentDays).toBe(14);
    expect(DEFAULT_OPTIONS.correctionVisibleDays).toBe(30);
    for (const tag of ['price', 'quote', 'appointment', 'booking', 'contact', 'address', 'payment', 'dispute']) {
      expect(DEFAULT_OPTIONS.consequentialTags.has(tag)).toBe(true);
    }
  });
});
