// CompileQueue — the durable async-compile job ledger (spec §9.1)
//
// The queue is what makes "claims compiled in background" durable: jobs
// survive restarts, claims are atomic, crash recovery resets 'running' jobs
// to 'pending', and terminal outcomes (done/failed) map one-to-one onto the
// state-based freshness labels (EXTRACTED / FAILED).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CompileQueue } from '../../src/compile_queue/queue.js';

let dir: string;
let queue: CompileQueue;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-cq-'));
  queue = new CompileQueue(path.join(dir, 'indices', 'compile.db'));
});

afterEach(() => {
  queue.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('CompileQueue', () => {
  it('enqueue is idempotent and terminal outcomes are sticky', () => {
    expect(queue.enqueue('obs_1', 'project/alpha')).toBe('enqueued');
    expect(queue.enqueue('obs_1', 'project/alpha')).toBe('enqueued');
    expect(queue.stats().pending).toBe(1);

    queue.complete('obs_1');
    expect(queue.enqueue('obs_1', 'project/alpha')).toBe('terminal');

    queue.enqueue('obs_2', 'project/alpha');
    queue.fail('obs_2', 'boom');
    expect(queue.enqueue('obs_2', 'project/alpha')).toBe('terminal');
  });

  it('failed jobs can be retried explicitly', () => {
    queue.fail('obs_2', 'boom');
    expect(queue.enqueue('obs_2', 'project/alpha', { retry: true })).toBe('enqueued');
    expect(queue.get('obs_2')!.status).toBe('pending');
    expect(queue.get('obs_2')!.last_error).toBeNull();
  });

  it('claimBatch atomically claims N pending jobs with attempt accounting', () => {
    queue.enqueue('obs_1', 's');
    queue.enqueue('obs_2', 's');
    queue.enqueue('obs_3', 's');

    const claimed = queue.claimBatch(2);
    expect(claimed).toHaveLength(2);
    for (const job of claimed) expect(job.status).toBe('running');
    for (const job of claimed) expect(queue.get(job.observation_id)!.attempts).toBe(1);

    // No double-claim: the remaining batch is exactly the unclaimed job.
    const rest = queue.claimBatch(10);
    expect(rest).toHaveLength(1);
    expect(rest[0]!.observation_id).toBe('obs_3');
    expect(queue.claimBatch(10)).toHaveLength(0);

    // Stats reflect the ledger.
    const stats = queue.stats();
    expect(stats.running).toBe(3);
    expect(stats.pending).toBe(0);
  });

  it('resetStale recovers running jobs left by a dead process', () => {
    queue.enqueue('obs_1', 's');
    queue.claimBatch(10);
    expect(queue.stats().running).toBe(1);

    const reset = queue.resetStale();
    expect(reset).toBe(1);
    expect(queue.stats().pending).toBe(1);
    expect(queue.get('obs_1')!.attempt_started_at).toBeNull();
  });

  it('complete and fail transitions are durable and observable', () => {
    queue.enqueue('obs_1', 's');
    queue.enqueue('obs_2', 's');
    queue.claimBatch(10);
    queue.complete('obs_1');
    expect(queue.get('obs_1')!.status).toBe('done');
    expect(queue.get('obs_1')!.completed_at).not.toBeNull();

    queue.fail('obs_2', 'LLM outage');
    expect(queue.get('obs_2')!.status).toBe('failed');
    expect(queue.get('obs_2')!.last_error).toBe('LLM outage');
    expect(queue.get('obs_2')!.completed_at).not.toBeNull();

    // Reopen from disk — the ledger survives the process.
    queue.close();
    queue = new CompileQueue(path.join(dir, 'indices', 'compile.db'));
    expect(queue.get('obs_1')!.status).toBe('done');
    expect(queue.get('obs_2')!.status).toBe('failed');
  });
});
