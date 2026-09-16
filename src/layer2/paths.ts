// Layer 2 — page paths and spec-shaped category routing.
//
// Extracted from the compiler so page identity (slug → `page_<slug>` → `wiki/<dir>/<slug>.md`)
// has exactly one implementation: the compiler writes by it, and READ resolves entity → page
// by it, rather than by scanning the frontmatter of a compiled page (ADR-0013 → D2).

import path from 'path';
import type { Entity } from '../layer1/types.js';
import type { PageCategory, PageCategoryDir } from './types.js';

/** The canonical wiki subdirectories, in compile order. */
export const PAGE_CATEGORY_DIRS: readonly PageCategoryDir[] = [
  'concepts',
  'entities',
  'decisions',
  'synthesis',
  'tombstones',
  'profiles',
] as const;

/** Lowercase-hyphenated slug for a page: `page_<slug>`. */
export function entitySlug(canonicalName: string): string {
  return canonicalName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function pageIdForSlug(slug: string): string {
  return `page_${slug}`;
}

export function pageIdForEntity(entity: Entity): string {
  return pageIdForSlug(entitySlug(entity.canonical_name));
}

/**
 * Spec v1.5.4.2 page-category routing. The substrate's existing Entity.type vocabularies
 * (`person`, `agent`, `project`, `concept`, `decision`, `event`, `tool`, `organisation`,
 * `preference`, `manifest`) project onto the spec's page categories.
 *
 * Profiles are agent-only (see Profile target REFLECT); the compiler does not emit profile
 * pages here — `reflectSelfProfile` handles that surface.
 */
export function categoryDirForEntity(entity: Entity): PageCategoryDir {
  switch (entity.type) {
    case 'decision':
    case 'event':
      return 'decisions';
    case 'person':
    case 'agent':
    case 'project':
    case 'organisation':
    case 'manifest':
      return 'entities';
    default:
      // concept, tool, preference, plus anything new → concepts
      return 'concepts';
  }
}

/** The singular spec §9 category for a `PageCategoryDir`. */
export function pageCategoryForDir(dir: string): PageCategory | null {
  switch (dir) {
    case 'concepts': return 'concept';
    case 'entities': return 'entity';
    case 'decisions': return 'decision';
    case 'synthesis': return 'synthesis';
    case 'profiles': return 'profile';
    case 'tombstones': return 'tombstone';
    default: return null;
  }
}

/** Singular spec §9 category from a directory name or a legacy plural `category` value. */
export function toPageCategory(value: unknown): PageCategory | null {
  if (typeof value !== 'string') return null;
  const direct = pageCategoryForDir(value);
  if (direct) return direct;
  const singular = value.replace(/s$/, '');
  return pageCategoryForDir(singular);
}

/**
 * Spec-shaped page path: `wiki/<category>/<slug>.md`.
 * The scope is preserved inside the frontmatter, not the directory layout.
 */
export function entityPagePath(wikiDir: string, entity: Entity): string {
  return path.join(wikiDir, categoryDirForEntity(entity), `${entitySlug(entity.canonical_name)}.md`);
}
