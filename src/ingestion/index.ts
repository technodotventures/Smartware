// Ingestion public surface — importable as `smartware/ingestion`.

export {
  registerSourceEntry,
  listSourceEntries,
  getSourceEntry,
  requireActiveSource,
  type RegisterSourceParams,
} from './sources.js';
export type { SourceEntry, SourceKind, SourceStatus } from '../config.js';
export {
  handleIngest,
  MAX_INGEST_ITEMS,
  type IngestDeps,
} from './ingest.js';
export type {
  IngestHooks,
  IngestItem,
  IngestItemResult,
  IngestParams,
  IngestResult,
} from './types.js';
export type { BatchRecord } from './store.js';
export { IngestionStore } from './store.js';
export {
  computeSourceSyncStatus,
  type SourceLastSync,
  type SourceSyncScope,
  type SourceSyncStatus,
} from './sync.js';
