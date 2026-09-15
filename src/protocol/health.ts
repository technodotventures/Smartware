// Protocol — HEALTH handler (owner or read-granted actor).
//
// The host-facing health/metrics contract for a company brain (P1-3). It is a
// *counts and states* surface: every value is a number, id, timestamp or error
// code. It never carries tenant content — no observation bodies, no claim
// values, no actor display names, no scope content. That is enforced by the
// shape of the report, not by redaction at the edge.
//
// Authority is scope-based and fails closed:
//   - the owner sees the whole brain (lane counts + every scope);
//   - a registered actor holding `read` on at least one scope sees the
//     per-scope rows for exactly those scopes;
//   - an actor with no grant row is `actor_unregistered`; a registered actor
//     with no `read` capability anywhere is `insufficient_permission`.
//
// Definitions are part of the contract and are documented with each field
// (docs/integration/observability.md). "Unambiguous" is the point: a count is
// only reported in a lane whose population rule is written down.

import type { Actor } from '../layer0/types.js';
import type { SmartwareConfig } from '../config.js';
import type { Layer0Index } from '../layer0/index.js';
import type { ClaimStore } from '../layer1/store.js';
import type { SearchIndex } from '../layer3/search.js';
import type { FreshnessCounts } from '../layer2/types.js';
import type { CompileJobStatus } from '../compile_queue/queue.js';
import type { DenialSummary, RecoverySummary } from '../observability/metrics.js';
import type { LatencyReport } from '../observability/latency.js';
import { scanBackup, scanStorage, type BackupReport, type StorageReport } from '../observability/storage.js';
import { readReceipts, type ReceiptsSummary } from '../observability/receipts.js';
import { evaluateCoffeeTrialSlo, type SloReport } from '../observability/slo.js';
import type { SourceSyncStatus } from '../ingestion/sync.js';
import { countWikiPages, readManifest } from '../layer2/manifest.js';
import { ProtocolError } from '../auth/middleware.js';
import { checkGrant, isOwner } from '../auth/grants.js';

export interface HealthParams {
  actor: Actor;
  /**
   * Optional host-owned directory where this brain's backups are written.
   * The brain does not create backups; when the host points at the directory
   * it owns, health reports the newest backup's age against the trial budget.
   */
  backup_dir?: string;
}

/** Which lanes of Layer 3 hold rows, counted separately and by name. */
export interface Layer3IndexCounts {
  /**
   * Rows in the entity/topic FTS lane (`search_index`): one row per entity
   * whose claims were indexed as a page, plus one row per active claim of an
   * entity that has no page. NOT pages (that is `layer2.pages`) and NOT the
   * claim- or observation-granular lanes.
   */
  entity_index_rows: number;
  /** Rows in the claim-granular FTS lane (`claim_search_index`). */
  claim_index_rows: number;
  /** Rows in the raw-observation FTS lane (`observation_search_index`). */
  observation_index_rows: number;
  /** State-based freshness labels over the raw-observation lane. */
  observations_by_freshness: FreshnessCounts;
}

export interface HealthLaneCounts {
  layer0: { total: number; by_status: Record<string, number>; last_sequence: number };
  layer1: { claims: number; entities: number; last_replayed_sequence: number };
  layer2: { pages: number };
  layer3: Layer3IndexCounts;
}

/** Per-scope counts. Only the scopes the caller may read are present. */
export interface ScopeHealthCounts {
  scope: string;
  /** Layer 0 rows recorded for this scope, every effective status. */
  observations_recorded: number;
  /** Layer 0 rows whose effective status is `accepted`. */
  observations_accepted: number;
}

/**
 * The durable compile ledger's queue state. `depth` is outstanding work
 * (pending + running); `failed` is terminal and stays raw-searchable forever
 * (state-based freshness), so depth and failures answer different questions.
 * `oldest_pending_age_seconds` is the queue-stall signal. Null when the
 * derived ledger could not be opened — an honest degraded state.
 */
export interface CompileQueueHealth {
  depth: number;
  pending: number;
  running: number;
  done: number;
  failed: number;
  oldest_pending_at: string | null;
  oldest_pending_age_seconds: number | null;
  last_completed_at: string | null;
  last_failed_at: string | null;
}

/** What the core knows about ownership; health turns it into an age at report time. */
export interface OwnershipFacts {
  arbitration: 'external';
  enforcement: 'fencing' | 'none';
  role: 'writer' | 'observer' | 'unfenced_writer';
  presented_token: number | null;
  epoch_high_water: number;
  /** When the current write epoch was claimed (null when none has been). */
  epoch_claimed_at: string | null;
  refusals: number;
  last_refusal: { op: string; token: number | null; high_water: number; at: string } | null;
}

export interface OwnershipHealth {
  /** Ownership is arbitrated by the host (ADR-0007); the brain validates epochs. */
  arbitration: 'external';
  enforcement: 'fencing' | 'none';
  /**
   * This process's role in the ownership scheme:
   *   - `writer` — it presented an epoch (it may mutate canonical state);
   *   - `observer` — the brain is fenced and this process presented none: it
   *     cannot mutate (every mutation is refused `fencing_token_missing`);
   *   - `unfenced_writer` — legacy single-writer brain (epoch high-water 0).
   */
  role: 'writer' | 'observer' | 'unfenced_writer';
  /** Highest ownership epoch this brain has seen. */
  epoch_high_water: number;
  /** The epoch this writer presented, or null. */
  presented_token: number | null;
  /**
   * The current write epoch as the brain knows it: which epoch holds the right
   * to write, when it was claimed, and how old that claim is. `identity` is
   * always null — the brain knows the epoch, not who holds it; the host's
   * arbiter owns identity. Null when no epoch has ever been claimed.
   */
  holder: {
    epoch: number;
    claimed_at: string;
    age_seconds: number;
    identity: null;
  } | null;
  /**
   * Lease TTL. Always null, and deliberately so: the brain enforces ownership
   * by epoch comparison, not by expiry, so an expired lease is refused as a
   * stale epoch (`fencing_token_stale`) rather than accepted until a timer
   * fires. The TTL lives in the host's arbiter (`ttl_owner: 'host'`).
   */
  ttl_seconds: number | null;
  ttl_owner: 'host';
  /** Canonical mutations refused by the fencing guard so far. */
  refusals: number;
  last_refusal: { op: string; token: number | null; high_water: number; at: string } | null;
}

/** Ingestion cursor lag: how stale each committed stream checkpoint is. */
export interface IngestionStreamHealth {
  source_id: string;
  scope: string;
  /** Opaque host checkpoint, stored verbatim — the host resumes from it. */
  cursor: string;
  cursor_before: string | null;
  synced_at: string;
  /** now - synced_at, in seconds: age of the newest committed batch. */
  lag_seconds: number;
  batches: number;
  accepted: number;
  duplicated: number;
  quarantined: number;
  rejected: number;
}

export interface IngestionHealth {
  registered_sources: number;
  /** Registered sources that have never committed a batch (honest, not zero). */
  sources_never_synced: string[];
  /** Per (source, scope) stream rows, newest batch folded in. */
  streams: IngestionStreamHealth[];
  /** The stalest stream's lag, or null when nothing has ever synced. */
  max_lag_seconds: number | null;
}

/** One detected projection-vs-substrate mismatch, with the rule that found it. */
export interface DriftRecord {
  surface: 'wiki_manifest' | 'observation_fts';
  /** What the projection says it holds; null when it cannot be read. */
  expected: number | null;
  /** What the substrate actually holds. */
  observed: number;
  /** observed - expected; null when the projection is unreadable. */
  delta: number | null;
  state: 'in_sync' | 'drift' | 'unknown';
  /** The comparison rule, in one line — drift is never a vibe. */
  rule: string;
}

export interface DriftReport {
  /**
   * False when any record is `drift`. A record in state `unknown` means that
   * check could not run (e.g. no wiki manifest has been written yet) and does
   * not by itself make the report drift — read `records` for coverage.
   */
  in_sync: boolean;
  records: DriftRecord[];
}

export interface HealthReport {
  instance_id: string;
  version: string;
  generated_at: string;
  /** When this process opened the brain (restart detection). */
  opened_at: string;
  uptime_seconds: number;
  authority: {
    actor_id: string;
    tier: 'owner' | 'read_granted';
    /** `all` for the owner; the readable scope ids otherwise. */
    scopes: string[] | 'all';
  };
  brain: { open: true };
  ownership: OwnershipHealth;
  /** Owner-only operational block. Null = the derived ledger did not open. */
  compile_queue?: CompileQueueHealth | null;
  /** Owner-only. Ingestion cursor lag per committed stream. */
  ingestion?: IngestionHealth;
  /**
   * Owner-only. Retention/forget receipts folded from the ops log: how many
   * sweeps ran and the newest one's numeric details (never scope or content).
   */
  receipts?: ReceiptsSummary;
  /**
   * Owner-only. Bytes on disk by area. Directory-anchored classification: the
   * operational SQLite database counts under `other` (it mixes derived indexes
   * with ledgers) — see the field docs rather than trusting the split blindly.
   */
  storage?: StorageReport;
  /** Backup freshness of the host-owned backup directory, when configured. */
  backup?: BackupReport;
  /** Projection-vs-substrate checks; `in_sync` is false when any record drifts. */
  drift?: DriftReport;
  /**
   * Owner-only. Counts of refused operations, by error code and entry point;
   * never the actor identity or scope. `recent` is newest-first.
   */
  denied?: DenialSummary;
  /**
   * Owner-only. Bucket-resolution latency histograms for the sampled data-plane
   * operations (recall, observe, …). Ops with no samples are absent.
   */
  latency?: Record<string, LatencyReport>;
  /** Owner-only. Brain-open recovery scans: how many, and the newest findings. */
  recovery?: RecoverySummary;
  /**
   * Owner-only. The Coffee-trial SLO evaluation over this same report: which
   * objectives pass, which breached, and which have no evidence yet.
   */
  slo?: SloReport;
  counts: {
    /**
     * Brain-wide lane counts — owner only. A read-granted actor gets
     * `by_scope` for its scopes instead (cross-scope totals are other
     * clients' metadata).
     */
    lanes?: HealthLaneCounts;
    by_scope: ScopeHealthCounts[];
  };
}

export interface HealthDeps {
  config: SmartwareConfig;
  layer0: Layer0Index;
  store: ClaimStore;
  searchIndex: SearchIndex;
  dataDir: string;
  opsDir: string;
  wikiDir: string;
  /** Durable compile ledger; null when it could not be opened. */
  compileQueue: {
    stats(): Record<CompileJobStatus, number>;
    timingStats(): {
      oldest_pending_at: string | null;
      last_completed_at: string | null;
      last_failed_at: string | null;
    };
  } | null;
  /** Durable operational metrics (refusals, recovery events). */
  metrics: { denials(recentLimit?: number): DenialSummary; recovery(): RecoverySummary };
  /** Latency buffer + durable histograms (flushes before reporting). */
  latency: { report(): Record<string, LatencyReport> };
  /** Sync status projection (registered sources, cursors, batch outcomes). */
  ingestionStatus: () => SourceSyncStatus[];
  /** Backup directory the host owns and writes; absent = not configured. */
  backupDir?: string;
  ownership: OwnershipFacts;
  openedAt: string;
  now?: () => Date;
}

/** Ownership facts + the report's own clock = the reported ownership block. */
function buildOwnership(facts: OwnershipFacts, now: Date): OwnershipHealth {
  const claimedAt = facts.epoch_high_water > 0 ? facts.epoch_claimed_at : null;
  return {
    arbitration: facts.arbitration,
    enforcement: facts.enforcement,
    role: facts.role,
    epoch_high_water: facts.epoch_high_water,
    presented_token: facts.presented_token,
    holder: claimedAt === null
      ? null
      : {
          epoch: facts.epoch_high_water,
          claimed_at: claimedAt,
          age_seconds: Math.max(0, Math.round((now.getTime() - new Date(claimedAt).getTime()) / 1000)),
          identity: null,
        },
    ttl_seconds: null,
    ttl_owner: 'host',
    refusals: facts.refusals,
    last_refusal: facts.last_refusal,
  };
}

function resolveAuthority(actorId: string, config: SmartwareConfig): 'owner' | string[] {
  if (isOwner(actorId, config)) return 'owner';
  const known = config.grants.some(g => g.actor_id === actorId || g.actor_id === '*');
  if (!known) {
    throw new ProtocolError(
      'actor_unregistered',
      `Actor '${actorId}' is not registered with this Pod.`,
    );
  }
  const readable = config.scopes
    .map(entry => entry.id)
    .filter(scope => hasRead(actorId, scope, config));
  if (readable.length === 0) {
    throw new ProtocolError(
      'insufficient_permission',
      `Actor '${actorId}' holds no 'read' capability on any scope in this Pod.`,
    );
  }
  return readable;
}

function hasRead(actorId: string, scope: string, config: SmartwareConfig): boolean {
  return checkGrant(actorId, 'read', scope, config);
}

function buildQueueHealth(
  queue: NonNullable<HealthDeps['compileQueue']>,
  now: Date,
): CompileQueueHealth {
  const statuses = queue.stats();
  const timing = queue.timingStats();
  const oldest = timing.oldest_pending_at;
  return {
    depth: statuses.pending + statuses.running,
    pending: statuses.pending,
    running: statuses.running,
    done: statuses.done,
    failed: statuses.failed,
    oldest_pending_at: oldest,
    oldest_pending_age_seconds: oldest === null
      ? null
      : Math.max(0, Math.round((now.getTime() - new Date(oldest).getTime()) / 1000)),
    last_completed_at: timing.last_completed_at,
    last_failed_at: timing.last_failed_at,
  };
}

/** Fold the sync-status projection into the health report (owner-only). */
function buildIngestionHealth(statuses: SourceSyncStatus[], now: Date): IngestionHealth {
  const streams: IngestionStreamHealth[] = [];
  const neverSynced: string[] = [];
  for (const status of statuses) {
    if (status.scopes.length === 0) {
      neverSynced.push(status.source_id);
      continue;
    }
    for (const scope of status.scopes) {
      streams.push({
        source_id: status.source_id,
        scope: scope.scope,
        cursor: scope.cursor,
        cursor_before: scope.cursor_before,
        synced_at: scope.synced_at,
        lag_seconds: Math.max(0, Math.round((now.getTime() - new Date(scope.synced_at).getTime()) / 1000)),
        batches: scope.batches,
        accepted: scope.accepted,
        duplicated: scope.duplicated,
        quarantined: scope.quarantined,
        rejected: scope.rejected,
      });
    }
  }
  streams.sort((left, right) =>
    left.source_id.localeCompare(right.source_id) || left.scope.localeCompare(right.scope));
  const maxLag = streams.length === 0
    ? null
    : streams.reduce((max, stream) => Math.max(max, stream.lag_seconds), 0);
  return {
    registered_sources: statuses.length,
    sources_never_synced: neverSynced.sort(),
    streams,
    max_lag_seconds: maxLag,
  };
}

/**
 * Projection-vs-substrate checks. Each record names the rule it evaluated so a
 * nonzero delta is actionable (rebuild the projection / recompile the pages),
 * never a free-floating warning.
 */
function buildDrift(deps: HealthDeps): DriftReport {
  const records: DriftRecord[] = [];

  // 1. The wiki manifest is a projection of compiled pages: it states how many
  //    pages exist, the directory holds them.
  const pagesOnDisk = countWikiPages(deps.wikiDir);
  const manifest = readManifest(deps.wikiDir);
  const stated = manifest === null
    ? null
    : Number(/^\| Layer 2 \| Compiled pages \| (\d+) \|$/m.exec(manifest)?.[1] ?? NaN);
  const statedPages = stated === null || Number.isNaN(stated) ? null : stated;
  records.push({
    surface: 'wiki_manifest',
    expected: statedPages,
    observed: pagesOnDisk,
    delta: statedPages === null ? null : pagesOnDisk - statedPages,
    state: statedPages === null ? 'unknown' : (pagesOnDisk === statedPages ? 'in_sync' : 'drift'),
    rule: 'compiled pages stated in wiki/smartware.md vs .md page files on disk',
  });

  // 2. The raw-observation FTS window is a projection of accepted Layer-0
  //    observations (terminal states are excluded by construction, spec §10a).
  const byStatus = deps.layer0.countByStatus();
  const acceptedObservations = byStatus.accepted ?? 0;
  const indexed = deps.searchIndex.countObservations();
  records.push({
    surface: 'observation_fts',
    expected: acceptedObservations,
    observed: indexed,
    delta: indexed - acceptedObservations,
    state: indexed === acceptedObservations ? 'in_sync' : 'drift',
    rule: 'raw-observation FTS rows vs Layer-0 observations with effective_status accepted',
  });

  return { in_sync: !records.some(record => record.state === 'drift'), records };
}

export async function handleHealth(params: HealthParams, deps: HealthDeps): Promise<HealthReport> {
  const { config } = deps;
  const actorId = params.actor.id;
  const authority = resolveAuthority(actorId, config);
  const now = (deps.now ?? (() => new Date()))();
  const openedAt = new Date(deps.openedAt);

  const scopeIds = authority === 'owner'
    ? config.scopes.map(entry => entry.id)
    : authority;

  const byScope: ScopeHealthCounts[] = scopeIds.map(scope => ({
    scope,
    observations_recorded: deps.layer0.countByScope(scope),
    observations_accepted: deps.layer0.countAcceptedByScope(scope),
  }));

  const report: HealthReport = {
    instance_id: config.instance_id,
    version: config.version,
    generated_at: now.toISOString(),
    opened_at: deps.openedAt,
    uptime_seconds: Math.max(0, Math.round((now.getTime() - openedAt.getTime()) / 1000)),
    authority: {
      actor_id: actorId,
      tier: authority === 'owner' ? 'owner' : 'read_granted',
      scopes: authority === 'owner' ? 'all' : scopeIds,
    },
    brain: { open: true },
    ownership: buildOwnership(deps.ownership, now),
    drift: buildDrift(deps),
    storage: scanStorage(deps.dataDir),
    backup: scanBackup(params.backup_dir ?? deps.backupDir, now),
    counts: { by_scope: byScope },
  };

  if (authority === 'owner') {
    report.compile_queue = deps.compileQueue
      ? buildQueueHealth(deps.compileQueue, now)
      : null;
    report.ingestion = buildIngestionHealth(deps.ingestionStatus(), now);
    report.receipts = readReceipts(deps.opsDir);
    report.denied = deps.metrics.denials();
    report.latency = deps.latency.report();
    report.recovery = deps.metrics.recovery();
    // The SLO evaluation reads the report it is attached to — same numbers, one clock.
    report.slo = evaluateCoffeeTrialSlo(report, now);
    report.counts.lanes = {
      layer0: {
        total: deps.layer0.totalCount(),
        by_status: deps.layer0.countByStatus(),
        last_sequence: deps.layer0.getLastSequence(),
      },
      layer1: {
        claims: deps.store.claimCount(),
        entities: deps.store.entityCount(),
        last_replayed_sequence: deps.store.getLastReplayedSequence(),
      },
      layer2: { pages: countWikiPages(deps.wikiDir) },
      layer3: {
        entity_index_rows: deps.searchIndex.count(),
        claim_index_rows: deps.searchIndex.countClaims(),
        observation_index_rows: deps.searchIndex.countObservations(),
        observations_by_freshness: deps.searchIndex.countObservationsByFreshness(),
      },
    };
  }

  return report;
}
