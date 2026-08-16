export type TemporalAxis = 'valid_time' | 'transaction_time';
export type TemporalRangeRelation = 'overlaps' | 'starts_in';

export interface TemporalInterval {
  from: string | null;
  to: string | null;
}

export interface TemporalDocument {
  valid_time: TemporalInterval;
  transaction_time: TemporalInterval;
}

export type TemporalConstraint =
  | {
      mode: 'current';
      axis: TemporalAxis;
      /** Defaults to the current clock time when omitted. */
      at?: string;
    }
  | {
      mode: 'as_of';
      axis: TemporalAxis;
      at: string;
    }
  | {
      mode: 'range';
      axis: TemporalAxis;
      from: string;
      to: string;
      /** Defaults to interval overlap for backward compatibility. */
      relation?: TemporalRangeRelation;
    };

function instant(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be a valid ISO 8601 timestamp`);
  }
  return parsed;
}

function interval(
  document: TemporalDocument,
  axis: TemporalAxis,
): { from: number | null; to: number | null } {
  const value = document[axis];
  const from = value.from === null ? null : instant(value.from, `${axis}.from`);
  const to = value.to === null ? null : instant(value.to, `${axis}.to`);
  if (from !== null && to !== null && to <= from) {
    throw new Error(`${axis}.to must be after ${axis}.from`);
  }
  return { from, to };
}

function contains(
  value: { from: number | null; to: number | null },
  at: number,
): boolean {
  return (value.from === null || value.from <= at)
    && (value.to === null || at < value.to);
}

/**
 * Match a document against an explicit bi-temporal constraint.
 *
 * Intervals are half-open: [from, to). Valid time answers when the claim was
 * true in the represented world; transaction time answers when Smartware knew
 * it. The caller remains responsible for supplying policy-eligible documents.
 */
export function matchesTemporalConstraint(
  document: TemporalDocument,
  constraint: TemporalConstraint,
): boolean {
  const value = interval(document, constraint.axis);

  if (constraint.mode === 'current') {
    const at = constraint.at === undefined
      ? Date.now()
      : instant(constraint.at, 'temporal.at');
    return contains(value, at);
  }

  if (constraint.mode === 'as_of') {
    return contains(value, instant(constraint.at, 'temporal.at'));
  }

  const from = instant(constraint.from, 'temporal.from');
  const to = instant(constraint.to, 'temporal.to');
  if (to <= from) {
    throw new Error('temporal.to must be after from');
  }

  const relation = constraint.relation ?? 'overlaps';
  if (relation === 'starts_in') {
    return value.from !== null && from <= value.from && value.from < to;
  }
  if (relation !== 'overlaps') {
    throw new Error(`Unsupported temporal range relation: ${String(relation)}`);
  }

  return (value.from === null || value.from < to)
    && (value.to === null || from < value.to);
}
