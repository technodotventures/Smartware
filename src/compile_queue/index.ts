// Compile queue — public surface barrel.
//
// Sync-raw + async-compile write path (spec §9.1 / §10a): observations are
// written synchronously to Layer 0 and indexed raw-searchable; claim
// compilation runs in the background from this durable queue with the
// state-based freshness contract (unverified / EXTRACTED / FAILED).

export {
  CompileQueue,
  defaultCompileQueuePath,
} from './queue.js';
export type {
  CompileJob,
  CompileJobStatus,
} from './queue.js';

export {
  FingerprintIndex,
  defaultFingerprintIndexPath,
  openFingerprintIndex,
} from './fingerprint.js';

export {
  DEFAULT_COMPILE_BATCH_LIMIT,
  DEFAULT_COMPILE_INTERVAL_MS,
  openCompileQueue,
  podActorId,
  runCompileBatch,
  startCompileWorker,
  syncCompileQueue,
} from './worker.js';
export type {
  CompileBatchResult,
  CompileWorkerContext,
} from './worker.js';

export { nextClaimId, nextOperationId } from './ids.js';
