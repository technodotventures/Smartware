// Scope half-life pin (kanban t_574be8cd).
//
// `src/layer1/confidence.ts` keys the recency factor's half-life on the claim's
// `scope`. Pre-fix that table was keyed on the pre-rename spellings instead — a
// `personal` key and a `project/` prefix — so neither override this
// implementation *declares* (`staleness: { default_half_life_days: 90,
// scope_overrides: { self: 365, 'project:*': 30 } }`) reached the lane the
// published `$defs/Scope` vocabulary names, while two spellings it rejects
// (`personal`, `project/foo`) did carry them.
//
// The half-life is read back OUT of the shipped `computeConfidence` rather than
// asserted from a private copy of the table: three ages cancel the formula's
// constants (see `impliedHalfLife`), so what is asserted here is the value the
// shipped function applied. The pre-fix revision fails the same assertions with
// the *swap* — self 90 / personal 365 / project:foo 90 / project/foo 30 (the A/B
// pair; this file imports nothing the fix introduces so the identical bytes run
// on the RED arm).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Ajv2020, { type AnySchema } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, test } from 'vitest';

import { createDefaultConfig } from '../../src/config.js';
import { computeConfidence } from '../../src/layer1/confidence.js';
import { makeClaim } from '../helpers.js';

const DAY_MS = 86_400_000;
/** Two ages plus a fresh claim: enough to cancel every scope-independent constant. */
const OLD_DAYS = 180;
const RECENT_DAYS = 30;

/** The same claim shape at `ageDays`, differing only in `scope` (the probe's shape). */
function claimAt(scope: string, ageDays: number) {
  return makeClaim({
    scope,
    validity: { from: new Date(Date.now() - ageDays * DAY_MS).toISOString(), to: null },
  });
}

/**
 * The recency contribution is `0.5 ** (age / halfLife)` over one fixed claim
 * shape, so `(S(0) - S(OLD)) / (S(0) - S(RECENT))` depends on the half-life
 * alone. That ratio is strictly increasing in the half-life, so bisection
 * recovers the half-life the shipped function applied — no private copy of the
 * weights or of the table.
 */
function ratioAt(halfLifeDays: number): number {
  return (1 - Math.pow(0.5, OLD_DAYS / halfLifeDays)) / (1 - Math.pow(0.5, RECENT_DAYS / halfLifeDays));
}

function impliedHalfLife(scope: string): number {
  const fresh = computeConfidence(claimAt(scope, 0));
  const old = computeConfidence(claimAt(scope, OLD_DAYS));
  const recent = computeConfidence(claimAt(scope, RECENT_DAYS));
  const target = (fresh - old) / (fresh - recent);
  assert.ok(
    target > 1 && target < OLD_DAYS / RECENT_DAYS,
    `no decay measurable for '${scope}': recency ratio ${target}`,
  );

  let lo = 0.001;
  let hi = 1e7;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (ratioAt(mid) < target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The published vocabularies the lanes below are named from. */
function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  const dir = path.join(process.cwd(), 'schemas', 'v0.5.0');
  for (const file of readdirSync(dir).filter(f => f.endsWith('.schema.json')).sort()) {
    ajv.addSchema(JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as AnySchema);
  }
  return ajv;
}

function admitsScope(value: string): boolean {
  const validate = createAjv().compile({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: 'https://smartware.dev/schemas/v0.5.0/common.schema.json#/$defs/Scope',
  });
  return validate(value);
}

// The declared numbers, read from the implementation's own default config — not
// hardcoded here, so a config change and this table cannot drift apart silently.
const declared = createDefaultConfig(path.join(os.tmpdir(), 'sw-half-life-pin')).staleness;
const DECLARED_POD = declared.scope_overrides.self;
const DECLARED_PROJECT = declared.scope_overrides['project:*'];
const DECLARED_DEFAULT = declared.default_half_life_days;

/** The pre-fix lane spellings — vocabulary-invalid, and not registered by any revision. */
const PRE_FIX_POD_SPELLING = 'personal';
const PRE_FIX_PROJECT_SPELLING = 'project/foo';

/** Confidence is a float over `Date.now()`; two claims built µs apart differ in the last bits. */
function assertSameConfidence(actual: number, expected: number, message: string): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${message} (actual ${actual}, expected ${expected})`,
  );
}

describe('the half-life `computeConfidence` applies per scope', () => {
  test('the declared overrides reach the lanes the published vocabulary names', () => {
    for (const lane of ['self', 'project:default', 'project:foo']) {
      assert.ok(admitsScope(lane), `'${lane}' is a published vocabulary lane`);
    }

    const pod = impliedHalfLife('self');
    assert.ok(
      Math.abs(pod - DECLARED_POD) < 1,
      `'self' must carry the declared pod override (${DECLARED_POD}d); measured ${pod.toFixed(1)}d`,
    );

    for (const lane of ['project:default', 'project:foo']) {
      const project = impliedHalfLife(lane);
      assert.ok(
        Math.abs(project - DECLARED_PROJECT) < 1,
        `'${lane}' must carry the declared 'project:*' override (${DECLARED_PROJECT}d); `
        + `measured ${project.toFixed(1)}d`,
      );
    }
  });

  test('a lane with no declared override decays at the declared default', () => {
    // `workspace` and the other vocabulary lanes, plus a host-registered lane
    // (`pod/<pod>/<lane>`, ADR-0015) which no override names.
    for (const lane of ['workspace', 'agent:neo', 'client:acme#1', 'pod/p1/personal', 'pod/p1/workspace']) {
      const measured = impliedHalfLife(lane);
      assert.ok(
        Math.abs(measured - DECLARED_DEFAULT) < 1,
        `'${lane}' declares no override: expected the ${DECLARED_DEFAULT}d default, `
        + `measured ${measured.toFixed(1)}d`,
      );
    }
  });

  test('the pre-rename spellings carry no override (the swap this card fixes)', () => {
    assert.equal(admitsScope(PRE_FIX_POD_SPELLING), false, `'${PRE_FIX_POD_SPELLING}' is outside $defs/Scope`);
    assert.equal(admitsScope(PRE_FIX_PROJECT_SPELLING), false, `'${PRE_FIX_PROJECT_SPELLING}' is outside $defs/Scope`);

    // Pre-fix these two carried the overrides and the vocabulary lanes above did
    // not — i.e. the exact reverse of the two assertions in this file's first test.
    const podSpelling = impliedHalfLife(PRE_FIX_POD_SPELLING);
    assert.ok(
      Math.abs(podSpelling - DECLARED_DEFAULT) < 1,
      `the pre-fix spelling '${PRE_FIX_POD_SPELLING}' must decay at the ${DECLARED_DEFAULT}d default `
      + `(pre-fix it carried ${DECLARED_POD}d); measured ${podSpelling.toFixed(1)}d`,
    );
    const projectSpelling = impliedHalfLife(PRE_FIX_PROJECT_SPELLING);
    assert.ok(
      Math.abs(projectSpelling - DECLARED_DEFAULT) < 1,
      `the pre-fix spelling '${PRE_FIX_PROJECT_SPELLING}' must decay at the ${DECLARED_DEFAULT}d default `
      + `(pre-fix it carried ${DECLARED_PROJECT}d); measured ${projectSpelling.toFixed(1)}d`,
    );

    // The swap, in one line: the two spellings of the same lane no longer agree.
    assert.notEqual(
      Math.round(impliedHalfLife('self')),
      Math.round(podSpelling),
      'the pod lane and its pre-rename spelling must not share a half-life once the table is vocabulary-keyed',
    );
  });

  test('the lane-keyed values are what a caller observes, not just the ratio', () => {
    // The measured effect on the public surface (`./layer1/confidence` is a
    // published package subpath): on identical claims 180 days old, the pod lane
    // is worth more than a lane with no override, and a `project:<id>` lane is
    // worth less — while the two pre-rename spellings now read as the default.
    const pod = computeConfidence(claimAt('self', OLD_DAYS));
    const defaultLane = computeConfidence(claimAt('workspace', OLD_DAYS));
    const project = computeConfidence(claimAt('project:foo', OLD_DAYS));

    assert.ok(pod > defaultLane, `self (${pod.toFixed(4)}) must exceed workspace (${defaultLane.toFixed(4)})`);
    assert.ok(
      project < defaultLane,
      `project:<id> (${project.toFixed(4)}) must decay faster than workspace (${defaultLane.toFixed(4)})`,
    );
    assertSameConfidence(
      computeConfidence(claimAt(PRE_FIX_POD_SPELLING, OLD_DAYS)),
      defaultLane,
      'the pre-rename pod spelling now reads as a lane with no override',
    );
    assertSameConfidence(
      computeConfidence(claimAt(PRE_FIX_PROJECT_SPELLING, OLD_DAYS)),
      defaultLane,
      'the pre-rename project spelling now reads as a lane with no override',
    );
  });
});
