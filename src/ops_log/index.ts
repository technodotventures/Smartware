// Operations log — public surface barrel.
//
// See docs/atomicity.md for design and PR-by-PR rollout plan.

export { OPERATION_ID_PATTERN, isValidOperationId } from './types.js';
export type { OpLogEntry, OpType } from './types.js';

export {
  appendOpLogEntry,
  appendOpLogEntries,
  dayOfTimestamp,
  loadCommittedOperationIds,
  readAllOpLogEntries,
  readOpLogDay,
} from './log.js';

export { OpsIndex, openOpsIndex, defaultOpsIndexPath } from './ops_index.js';

export { runCommit, runCommitSync } from './commit.js';
export type { CommitContext, CommitDescriptor, CommitResult } from './commit.js';

export {
  persistOperationIntent,
  readOperationIntent,
  readOperationIntentRecords,
  removeOperationIntent,
} from './intent.js';
export type {
  EndorseOperationIntent,
  ForgetOperationIntent,
  ForgetScopeOperationIntent,
  OperationIntent,
  ObservationOperationIntent,
  OperationIntentReadRecord,
  ReviseOperationIntent,
  ReviveOperationIntent,
  ReflectClaimOperationIntent,
} from './intent.js';

export { classifyOrphan, runRecovery } from './recovery.js';
export type { OrphanArtifact, RecoveryContext, RecoveryReport } from './recovery.js';
