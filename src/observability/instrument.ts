// Observability — host-facing boundary instrumentation (P1-3).
//
// SmartwareCore.open() returns a core wrapped so that every host-facing call
// is accounted at the boundary the host actually used:
//
//   - a refusal (a ProtocolError whose code denies the caller the operation it
//     asked for) increments the durable denial counters;
//   - recall/write latency is sampled into histograms (see latency.ts).
//
// Internal delegation is NOT double-counted: methods called on `this` inside
// the core bypass the proxy, so an `recall()` that internally calls `query()`
// records one refusal under the entry point the host called.
//
// The instrumentation must never change behaviour: recording is best-effort
// (a metrics-store failure is swallowed), the original error is re-thrown
// untouched, and the wrapper is transparent to `instanceof`, property access
// and close().

import type { SmartwareCore } from '../core.js';
import { ProtocolError } from '../auth/middleware.js';
import type { MetricsStore } from './metrics.js';
import { LATENCY_OPS, type LatencyRecorder } from './latency.js';

/**
 * ProtocolError codes that count as *denied access*: an authority, policy or
 * epoch refusal that denies the caller the operation it asked for.
 *
 * Deliberately NOT counted: input validation and lookup failures
 * (`invalid_parameter`, `not_found`, `conflict`, …) and operation
 * preconditions (`scope_not_empty`, `package_corrupt`, `terminal_state`) —
 * those are not access decisions. The list is part of the health contract and
 * is documented in docs/integration/observability.md.
 */
export const DENIAL_CODES: ReadonlySet<string> = new Set([
  // authority
  'actor_unregistered',
  'insufficient_permission',
  'owner_required',
  'user_required',
  'forbidden',
  // ownership epoch (ADR-0007)
  'fencing_token_stale',
  'fencing_token_missing',
  // session policy
  'read_disabled',
  'write_disabled',
  // sensitive-content gates
  'sensitive',
  'sensitive_opt_in_required',
  // source context (fail-closed ingestion)
  'source_required',
  'source_unregistered',
  'source_inactive',
  // protected voice
  'protected_claim',
  'protected_revival',
]);

/** Data-plane operations whose latency is sampled (see latency.ts). */
const LATENCY_SET: ReadonlySet<string> = new Set(LATENCY_OPS);

export function isDenial(error: unknown): error is ProtocolError {
  return error instanceof ProtocolError && DENIAL_CODES.has(error.code);
}

function recordRefusal(metrics: MetricsStore, op: string, error: unknown): void {
  if (!isDenial(error)) return;
  try {
    metrics.recordDenial(error.code, op);
  } catch {
    // Metrics are operational telemetry: they must never break the brain.
  }
}

function recordLatency(latency: LatencyRecorder, op: string, durationMs: number): void {
  if (!LATENCY_SET.has(op)) return;
  try {
    latency.record(op, durationMs);
  } catch {
    // Same rule: telemetry never breaks the call it measures.
  }
}

/**
 * Wrap a core so host-facing calls are accounted. Only prototype methods are
 * wrapped (data fields are returned as-is); `constructor` and `close()` are
 * passed through untouched.
 */
export function installObservability(
  core: SmartwareCore,
  metrics: MetricsStore,
  latency: LatencyRecorder,
): SmartwareCore {
  return new Proxy(core, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || typeof value !== 'function') return value;
      if (property === 'constructor' || property === 'close') return value;
      if (Object.prototype.hasOwnProperty.call(target, property)) return value;

      return (...args: unknown[]) => {
        const call = value as (this: unknown, ...a: unknown[]) => unknown;
        const startedAt = performance.now();
        try {
          const result = call.apply(target, args);
          if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
            return (result as PromiseLike<unknown>).then(
              (settled: unknown) => {
                recordLatency(latency, property, performance.now() - startedAt);
                return settled;
              },
              (error: unknown) => {
                recordRefusal(metrics, property, error);
                throw error;
              },
            );
          }
          recordLatency(latency, property, performance.now() - startedAt);
          return result;
        } catch (error) {
          recordRefusal(metrics, property, error);
          throw error;
        }
      };
    },
  });
}
