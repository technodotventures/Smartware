import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SearchIndex } from '../../src/layer3/search.js';

let tmpDir: string;
let searchIndex: SearchIndex;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-search-scope-'));
  searchIndex = new SearchIndex(path.join(tmpDir, 'search.db'));
});

afterEach(() => {
  searchIndex.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SearchIndex scoped retrieval', () => {
  it('applies the page scope before the result limit', () => {
    const db = searchIndex.getDB();
    const insert = db.prepare(`
      INSERT INTO search_index (entity_id, entity_name, scope, content)
      VALUES (?, ?, ?, ?)
    `);
    const seed = db.transaction(() => {
      for (let index = 0; index < 201; index++) {
        insert.run(
          `entity_other_${index}`,
          `Other ${index}`,
          'project/other',
          'needle alpha needle alpha needle alpha',
        );
      }
      insert.run('entity_wanted', 'Wanted', 'project/wanted', 'needle alpha');
    });
    seed();

    expect(searchIndex.search('needle alpha', 'project/wanted')).toEqual([
      expect.objectContaining({ entity_id: 'entity_wanted', scope: 'project/wanted' }),
    ]);
  });

  it('applies the claim scope before the result limit', () => {
    const db = searchIndex.getDB();
    const insert = db.prepare(`
      INSERT INTO claim_search_index
        (claim_id, entity_id, entity_name, scope, predicate, content)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const seed = db.transaction(() => {
      for (let index = 0; index < 201; index++) {
        insert.run(
          `claim_other_${index}`,
          `entity_other_${index}`,
          `Other ${index}`,
          'project/other',
          'description_is',
          'needle alpha needle alpha needle alpha',
        );
      }
      insert.run(
        'claim_wanted',
        'entity_wanted',
        'Wanted',
        'project/wanted',
        'description_is',
        'needle alpha',
      );
    });
    seed();

    expect(searchIndex.searchClaims('needle alpha', 'project/wanted')).toEqual([
      expect.objectContaining({ claim_id: 'claim_wanted', scope: 'project/wanted' }),
    ]);
  });
});
