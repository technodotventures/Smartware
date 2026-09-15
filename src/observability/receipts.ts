// Observability — retention/forget receipts (P1-3).
//
// A receipt answers "did the sweep actually run, and what did it remove?".
// It is a fold of the canonical operations log — the same source of truth the
// ops-entry lookup uses — so a receipt can never disagree with the ledger it
// summarises.
//
// Privacy rule, enforced by construction: only the ops entry's *numeric*
// details are carried (`details_counts`), plus the operation id, op name and
// timestamp. Scope ids, actor ids, observation ids and every other string in
// `details` are dropped. A receipt is therefore safe to render on a host
// dashboard: it says how much was removed, never from whom.
//
// Cost: one streaming pass over the ops JSONL, O(entries), no full
// materialisation (the reader is a generator). Called only for owner reports.

import { readAllOpLogEntries } from '../ops_log/log.js';
import type { OpLogEntry, OpType } from '../ops_log/types.js';

const RETENTION_OPS: readonly OpType[] = ['retention.expire'];
const FORGET_OPS: readonly OpType[] = ['forget', 'forget.scope'];

/** One receipt: an op id, a time, and the numeric details only. */
export interface Receipt {
  operation_id: string;
  op: OpType;
  at: string;
  details_counts: Record<string, number>;
}

export interface ReceiptsSummary {
  retention_expiries: { total: number; last: Receipt | null };
  forgets: { total: number; individual_forgets: number; scope_forgets: number; last: Receipt | null };
}

export function readReceipts(opsDir: string): ReceiptsSummary {
  const summary: ReceiptsSummary = {
    retention_expiries: { total: 0, last: null },
    forgets: { total: 0, individual_forgets: 0, scope_forgets: 0, last: null },
  };

  for (const entry of readAllOpLogEntries(opsDir)) {
    const receipt = toReceipt(entry);
    if (RETENTION_OPS.includes(entry.op)) {
      summary.retention_expiries.total += 1;
      summary.retention_expiries.last = receipt;
    } else if (FORGET_OPS.includes(entry.op)) {
      summary.forgets.total += 1;
      if (entry.op === 'forget') summary.forgets.individual_forgets += 1;
      else summary.forgets.scope_forgets += 1;
      summary.forgets.last = receipt;
    }
  }

  return summary;
}

function toReceipt(entry: OpLogEntry): Receipt {
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(entry.details ?? {})) {
    if (typeof value === 'number' && Number.isFinite(value)) counts[key] = value;
  }
  return { operation_id: entry.operation_id, op: entry.op, at: entry.timestamp, details_counts: counts };
}
