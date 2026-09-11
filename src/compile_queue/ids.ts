// Fast ULID-shaped id generation for the compile path.
//
// The OperationId contract is `/^op_[0-9A-HJKMNP-TV-Z]{26}$/` (ULID-shaped
// Crockford base32). The `ulid` package's per-call crypto.randomFillSync
// measured ~1.3s per 10k IDs — a top-4 cost in the §11.2 re-run profile.
// This generator keeps the exact same shape (10-char time prefix +
// 16-char entropy) but refills its random buffer in bulk (4KB per fill) and
// never hits the RNG per ID. Collision resistance: 80 bits of per-ID entropy,
// same order as ULID's random entropy; the time prefix keeps monotonicity
// across restarts.

import { randomFillSync } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let entropy = Buffer.alloc(0);
let entropyOffset = 0;

function nextEntropyChars(count: number): string {
  if (entropy.length === 0 || entropyOffset + count > entropy.length) {
    entropy = Buffer.alloc(4096);
    randomFillSync(entropy);
    entropyOffset = 0;
  }
  let out = '';
  for (let i = 0; i < count; i++) {
    out += ALPHABET[entropy[entropyOffset + i]! % 32];
  }
  entropyOffset += count;
  return out;
}

/** op_ + 26 Crockford chars (matches OPERATION_ID_PATTERN). */
export function nextOperationId(now = Date.now()): string {
  let ts = now;
  const timeChars = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    timeChars[i] = ALPHABET[ts % 32]!;
    ts = Math.floor(ts / 32);
  }
  return `op_${timeChars.join('')}${nextEntropyChars(16)}`;
}

/** claim_ + 26 Crockford chars. */
export function nextClaimId(): string {
  return `claim_${nextOperationId().slice(3)}`;
}
