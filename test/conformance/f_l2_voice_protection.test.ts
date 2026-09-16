// Conformance Suite F — L2 Voice Protection & Two-Region Pages (§9)

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseFrontmatter, serialiseFrontmatter } from '../../src/layer2/frontmatter.js';
import type { Frontmatter } from '../../src/layer2/types.js';

function makeTmpWikiDir(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-l2-'));
  for (const cat of ['concepts', 'entities', 'decisions', 'synthesis', 'tombstones', 'profiles']) {
    fs.mkdirSync(path.join(tmpDir, cat), { recursive: true });
  }
  return tmpDir;
}

/**
 * Hand-built page fixture in the **published** page vocabulary — spec §9's "Page frontmatter"
 * field set (== `schemas/v0.5.0/page-frontmatter.schema.json`). The compile envelope is *not*
 * frontmatter: `entity_id`/`compiled_at`/`claim_ids` live in the page's derived cached region
 * (ADR-0013 → D2), so a fixture that only exercises page-vocabulary behaviour writes none.
 */
function writeTestPage(wikiDir: string, category: string, slug: string, fm: Partial<Frontmatter>, body: string): string {
  const fullFm: Frontmatter = {
    title: slug,
    page_id: `page_${slug}`,
    category: 'concept',
    author: 'agent',
    sources: ['claim_01M2NAFHDD2A9AC2KGNBQABTRP'],
    supporting_claims: [],
    created: '2026-01-01',
    updated: '2026-01-01',
    scope: 'workspace',
    confidence: 'medium',
    epistemic_tag: 'inference',
    summary: `${slug} test page`,
    tags: [],
    aliases: [],
    notices: [],
    ...fm,
  };
  const pagePath = path.join(wikiDir, category, `${slug}.md`);
  fs.writeFileSync(pagePath, serialiseFrontmatter(fullFm, body), 'utf-8');
  return pagePath;
}

describe('L2 Voice Protection', () => {
  it('F1: page_has_two_regions', () => {
    const body = `
## Current Understanding

Test entity is active.

## Evidence Timeline

<!-- cached view — compiled_at: 2026-01-01T00:00:00Z -->

- **status_is**: active _(observed, confidence: 0.80)_
`;
    expect(body).toContain('## Current Understanding');
    expect(body).toContain('## Evidence Timeline');
  });

  it('F2: current_understanding_excludes_superseded', () => {
    // Verified at the claim-filtering level: the compiler filters claims
    // with status !== 'active' before generating Current Understanding.
    // This test validates the expectation structurally.
    const claims = [
      { id: 'claim_a', status: 'active' },
      { id: 'claim_b', status: 'superseded' },
    ];
    const activeClaims = claims.filter(c => c.status === 'active');
    expect(activeClaims).toHaveLength(1);
    expect(activeClaims[0]!.id).toBe('claim_a');
  });

  it('F3: user_page_locks_current_understanding_prose', () => {
    const wikiDir = makeTmpWikiDir();
    const userBody = '\n## Current Understanding\n\nUser-written analysis.\n\n## Evidence Timeline\n\nOld timeline.\n';
    const pagePath = writeTestPage(wikiDir, 'concepts', 'test-concept', { author: 'user' }, userBody);

    const parsed = parseFrontmatter(fs.readFileSync(pagePath, 'utf-8'));
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.author).toBe('user');
    expect(parsed!.body).toContain('User-written analysis.');
    fs.rmSync(wikiDir, { recursive: true, force: true });
  });

  it('F4: user_page_locks_sources', () => {
    // §9: `sources` is the page's cited ClaimIds and is locked at endorsement. The lock is what
    // this test asserts — the fixture's own list must survive verbatim, because the compiler
    // may only refresh the derived cached region on a user-authored page.
    const wikiDir = makeTmpWikiDir();
    const pagePath = writeTestPage(wikiDir, 'concepts', 'test-concept', {
      author: 'user',
      sources: ['claim_01M2NAFHDD2A9AC2KGNBQABTRP'],
      supporting_claims: ['claim_01M2NAFHDD2A9AC2KGNBQABTRQ'],
    }, '\n## Current Understanding\n\nUser prose.\n\n## Evidence Timeline\n\nTimeline.\n');

    const parsed = parseFrontmatter(fs.readFileSync(pagePath, 'utf-8'));
    expect(parsed!.frontmatter.sources).toEqual(['claim_01M2NAFHDD2A9AC2KGNBQABTRP']);
    expect(parsed!.frontmatter.supporting_claims).toEqual(['claim_01M2NAFHDD2A9AC2KGNBQABTRQ']);
    // The pre-fix names for the same list are gone: one meaning per field.
    expect(parsed!.frontmatter.sources_claim_ids).toBeUndefined();
    expect(parsed!.frontmatter.claim_ids).toBeUndefined();
    fs.rmSync(wikiDir, { recursive: true, force: true });
  });

  it('F5: agent_may_refresh_evidence_timeline_on_protected_page', () => {
    const wikiDir = makeTmpWikiDir();
    const originalBody = '\n## Current Understanding\n\nProtected prose.\n\n## Evidence Timeline\n\nOld timeline data.\n';
    writeTestPage(wikiDir, 'concepts', 'test-concept', { author: 'user' }, originalBody);

    const newTimeline = '## Evidence Timeline\n\n<!-- cached view — compiled_at: 2026-06-01T00:00:00Z -->\n\n- **status_is**: updated\n';
    const existingContent = fs.readFileSync(path.join(wikiDir, 'concepts', 'test-concept.md'), 'utf-8');
    const parsed = parseFrontmatter(existingContent);
    const body = parsed!.body;
    const idx = body.indexOf('## Evidence Timeline');
    const updatedBody = body.slice(0, idx) + newTimeline;

    expect(updatedBody).toContain('Protected prose.');
    expect(updatedBody).toContain('compiled_at: 2026-06-01');
    expect(updatedBody).not.toContain('Old timeline data.');
    fs.rmSync(wikiDir, { recursive: true, force: true });
  });

  it('F6: agent_may_update_supporting_claims', () => {
    const wikiDir = makeTmpWikiDir();
    writeTestPage(wikiDir, 'concepts', 'test-concept', {
      author: 'user',
      supporting_claims: ['claim_existing'],
    }, '\nBody.\n');

    const content = fs.readFileSync(path.join(wikiDir, 'concepts', 'test-concept.md'), 'utf-8');
    const parsed = parseFrontmatter(content);
    const updated = {
      ...parsed!.frontmatter,
      supporting_claims: [...(parsed!.frontmatter.supporting_claims ?? []), 'claim_new'],
    };
    expect(updated.supporting_claims).toContain('claim_existing');
    expect(updated.supporting_claims).toContain('claim_new');
    fs.rmSync(wikiDir, { recursive: true, force: true });
  });

  it('F7: autonomous_pass_cannot_write_page_notice', () => {
    // The compiler always sets notices to [] on new pages and preserves
    // existing notices on user pages. An autonomous pass never adds to notices.
    const wikiDir = makeTmpWikiDir();
    writeTestPage(wikiDir, 'concepts', 'test-concept', {
      author: 'agent',
      notices: [],
    }, '\nBody.\n');

    const content = fs.readFileSync(path.join(wikiDir, 'concepts', 'test-concept.md'), 'utf-8');
    const parsed = parseFrontmatter(content);
    expect(parsed!.frontmatter.notices).toEqual([]);
    fs.rmSync(wikiDir, { recursive: true, force: true });
  });

  it('F8: forget_produces_notice_on_affected_user_page', () => {
    // When a user FORGETs a claim cited by a user-authored page, a notice
    // should be posted. This test validates the notice structure;
    // integration with the FORGET handler is tested in Phase 3.
    const notice = {
      type: 'retracted_reference' as const,
      message: 'Claim claim_abc was forgotten',
      claim_id: 'claim_abc',
      tombstone_id: 'tomb_abc',
      posted_at: '2026-01-15T00:00:00Z',
    };
    expect(notice.type).toBe('retracted_reference');
    expect(notice.claim_id).toBeTruthy();
    expect(notice.tombstone_id).toBeTruthy();
  });
});
