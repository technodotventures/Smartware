# Coffee reference adapter — drop-in contract

**Status:** reference integration, executable (not yet exercised against Coffee
staging — staging is unavailable; the deterministic local proof below is the
accepted evidence for this cut).

**Audience:** the engineer wiring Smartware into Coffee. You keep your own
extraction pipeline, your Redis, your auth; this document is the contract your
code calls and the contract you must satisfy.

| Piece | Where |
|---|---|
| Adapter implementation | [`examples/coffee-adapter/adapter.mjs`](../../examples/coffee-adapter/adapter.mjs) |
| Provisioning template | [`examples/coffee-adapter/config.template.json`](../../examples/coffee-adapter/config.template.json) |
| Executable proof | [`scripts/coffee-adapter-smoke.mjs`](../../scripts/coffee-adapter-smoke.mjs) — `npm run verify:coffee-adapter` |
| Resilient host patterns it productizes | [saas-integration.md §1h](saas-integration.md) (lease, guard, fence, app-store outage) |
| Fence semantics it relies on | [ADR-0007](../adr/0007-fencing-token-at-the-mutation-boundary.md) |
| Health surface it embeds | [observability.md](observability.md), ADR-0008 |

Verdict labels used below: **VERIFIED** = measured in the smoke run;
**DESIGNED** = specified here, not measured; **NOT YET PROVEN** = explicitly
open.

---

## 1. The shape

```
Coffee replica (1..N)                         Smartware brain (single writer)
┌───────────────────────────┐                 ┌──────────────────────────────┐
│ HTTP/WS handlers          │                 │ <brain_dir>/smartware.db     │
│  └─ CoffeeBrainAdapter ───┼── ports ───┐    │ <brain_dir>/config.json      │
│       │  extract claims   │            │    │ <brain_dir>/evidence/*.jsonl │
│       │  (your pipeline)  │            │    └──────────────────────────────┘
│       └─ app store (Redis)│            │          ▲  SmartwareCore
└───────────────────────────┘            │          │  ClaimStore/SearchIndex
        authoritative for app data       └── arbiter┘  (public package paths)
                                              = Redis lease + epoch
```

- **One business = one brain** (one `data_dir`, one `config.json`). The brain is
  a *resource* per business, not per request and not per replica.
- **A client is a scope** (`client:<id>#<n>`, non-reusable). Staff and agents
  are **grants** on exact scope ids.
- **Redis stays authoritative** for application data. The brain is additive: if
  it is unavailable, Coffee still works (degraded) and says so.
- **Single writer.** A replica writes the brain only while it holds the lease;
  the brain's fence (ADR-0007) is the second line for a writer that stalls
  between its guard and its mutation.
- **No model credential.** Extraction is Coffee's; the adapter persists the
  claims you already extract (`llm.provider: 'none'`). VERIFIED: the smoke runs
  with no provider configured.

## 2. What you implement (two ports)

The adapter owns no Redis dependency: you inject the two ports. The commands
shown are the exact Redis operations the pilot measured; implement them however
your client library is shaped.

### `ports.appStore` — authoritative application store

| Method | Contract | Redis sketch |
|---|---|---|
| `appendOnce({key, operationId, record}) -> {written, len}` | Idempotent **when `operationId` is provided** (same op ⇒ `written:false`, nothing appended); a missing op id is not deduplicated | `SET <key>:op:<opid> 1 NX` then `LPUSH <key> <json>`; else append only |
| `list({key}) -> record[]` | All records for one scope, oldest first | `LRANGE <key> 0 -1` |
| `getDrift({key}) -> number` | Recorded app-side/brain divergences for a scope | `GET <key>` |
| `incrDrift({key}) -> number` | Increment and return | `INCR <key>` |

Keep the record shape the adapter writes (`{ts, actor, scope, text, source_ref,
operation_id}`) — the degraded read returns these rows verbatim, so the host
renders its own UI from its own schema.

### `ports.arbiter` — ownership arbiter (Redis lease + monotonic epoch)

| Method | Contract | Redis sketch (exact) |
|---|---|---|
| `tryAcquire({key, holder, ttlMs}) -> boolean` | Acquire if free; true if already ours | `SET <key> <holder> NX PX <ttl>` |
| `renewIfHeld({key, holder, ttlMs}) -> boolean` | **Compare-and-extend.** Renew only if the value is still ours | Lua: `if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('pexpire',KEYS[1],ARGV[2]) else return 0 end` |
| `releaseIfHeld({key, holder}) -> boolean` | Release only if ours (fast failover path) | Lua compare + `DEL` |
| `holder(key) -> string \| null` | Who holds it now | `GET` |
| `nextEpoch(key) -> number` | Monotonic, one per ownership acquisition | `INCR <key>` |

> **`SET key me XX PX ttl` is not a renewal.** `XX` checks existence, not
> identity: a replica whose lease was already handed over takes it *back*, and
> two replicas believe they own the brain. The smoke reproduces exactly that
> hazard and shows the compare-and-extend contract refusing it
> (`17a`/`17b`, VERIFIED).

Derive the keys from the brain's own provisioning surface, never from the mount
path — the adapter exports the functions:

```js
import { brainIdentity, leaseKeyFor, fenceEpochKeyFor, messagesKeyFor, driftKeyFor } from './coffee-adapter/adapter.mjs';

const identity = brainIdentity({ brainDir, tenant });   // "<workspace>.<instance>" from config.json
// coffee:brainlease:ava-consulting.smartware_ava
// coffee:brainfence:ava-consulting.smartware_ava
// coffee:ava-consulting.smartware_ava:messages:client:acme#1
// coffee:ava-consulting.smartware_ava:drift:client:acme#1
```

Identity resolution order: the brain's `config.json` (authoritative once the
brain exists), else the provisioning object you are about to write, else **fail
closed** (no path-derived identity — a mount point is not an identity, and two
businesses with a client named "acme" must never share a key).

## 3. Lifecycle

```js
import { CoffeeBrainAdapter, coffeeTenantConfig, newOperationId } from './coffee-adapter/adapter.mjs';

const adapter = new CoffeeBrainAdapter({
  tenant,                    // provisioning object (see config.template.json)
  brainDir: '/var/lib/smartware/<workspace>/<instance>',
  instanceId: `inst_${process.pid}`,   // the lease holder identity
  ports: { appStore, arbiter },
  leaseTtlMs: 8000,
});
await adapter.start();       // provisions config.json if absent, then acquires or stands by
// ... poll ownership on a timer (ttl/3):  await adapter.refreshOwnership();
await adapter.stop();        // releases the lease (fast failover) and closes the brain handle
```

- `start()` writes `config.json` (mode 0600) only when it does not exist; the
  brain's own config is the identity source from then on.
- `refreshOwnership()` renews when owner, demotes when the renewal fails, and
  re-acquires in the same poll when the lease merely lapsed. A host that forgets
  the timer still fails closed: every write re-checks the lease itself.
- Shutdown releases the lease so a standby takes over immediately instead of
  waiting out the TTL (measured in the pilot at ~1 s; the smoke asserts the
  release path).

## 4. Write path (`adapter.handleWrite(...)`)

```js
const result = await adapter.handleWrite({
  actor: { type: 'person', id: 'user:gigi', display_name: 'Gigi' },  // YOUR authenticated identity
  client: 'acme',                       // or scope: 'client:acme#2'
  text: 'Acme renewal date is 2026-11-02',
  source_ref: 'src_gmail_ava',          // optional: a registered source (provenance)
  operation_id: newOperationId(),       // `op_<ULID>` — supply it; it is the retry key
  claims: [{
    subject: { name: 'Acme', type: 'organization' },   // or { id: 'entity_...' }
    predicate: 'renewal_date',
    object: { type: 'text', value: '2026-11-02' },
    validity_from: '2026-08-01T00:00:00.000Z',         // the FACT's validity start
  }],
});
```

Order of operations (each step is load-bearing):

1. **Validate shape, fail closed**: actor id/type, scope shape, non-empty text,
   `op_`+ULID operation id, claim shape. Nothing is written on failure.
2. **Settle ownership before either store** — not the holder ⇒ refusal with the
   holder's name and `partial_write: false`.
3. **Renew the lease (compare-and-extend)**. A lost lease here ⇒ clean refusal,
   nothing written, safe to retry elsewhere.
4. **Append to the app store** (authoritative, idempotent per `operation_id`).
5. *(drill seam: `hooks.afterGuard` — used by the smoke to model the stall the
   guard cannot cover.)*
6. **Write the brain** — `observe` under the current fence epoch, then persist
   your claims through the public conflict seam (`admitClaim`: inserted /
   corroborated / contested / superseded — never a twin, never last-write-wins),
   then `syncSearchFromClaims` so recall sees them.
7. On any brain failure, increment the drift counter and report the divergence
   in the response.

### Response and retry semantics (VERIFIED in the smoke)

| code | status | partial_write | retryable | What the caller does |
|---|---|---|---|---|
| — | 201 | false | — | Accepted; `claims.outcomes` says inserted/corroborated/contested/superseded |
| — | 200 (`replayed: true`) | false | — | Same operation already completed; nothing changed |
| `invalid_actor` / `invalid_scope` / `invalid_text` / `invalid_operation_id` / `invalid_claims` | 400/401 | false | false | Fix the caller; nothing was written |
| `lease_not_holder` | 503 | false | **true** | Route to `holder`, or retry after failover — nothing written |
| `lease_lost` | 503 | false | **true** | Ownership moved mid-request; nothing written — retry against the current holder |
| `fencing_token_stale` / `fencing_token_missing` | 503 | **true** | **true** | The brain refused a stale epoch before any artifact. The app record stands; retry the same `operation_id` against the new holder (app dedupes, brain completes) |
| `insufficient_permission` / `actor_unregistered` / other denials | 403 | **true** | false | The brain refused this actor. Fix the grant or the caller; reconcile the app-side row |
| `brain_unavailable` | 502 | **true** | true | Replay the brain half with the same `operation_id`; do not re-push the app record |
| `conflict` | 409 | true | false | The operation id was reused with a different payload — a caller bug |

The `hint` field on every refusal repeats the relevant instruction; `drift_total`
tells you how much reconciliation this scope has accumulated.

**Why app store first.** It is Coffee's own data: a message the product accepted
must not disappear because the memory layer was down. The cost is real and
stated: a brain refusal after the app write is a divergence you must reconcile,
counted per scope and reported in the response — never hidden.

## 5. Read path (`adapter.handleRecall(...)`)

```js
const read = await adapter.handleRecall({ actor, client: 'acme', query: 'Acme renewal', limit: 10 });
```

| State | Result |
|---|---|
| Lease holder, brain answers | `{ok:true, source:'brain', degraded:false, provenance:'brain', results:[…claim-bearing rows…]}` |
| Lease holder, brain **denies** | `{ok:false, status:403, code:<substrate code>, denied:true}` — a denial is never answered from the fallback |
| Lease holder, brain fails | Degraded fallback (below) with the brain error attached |
| Standby | Degraded fallback (below), `reason` names the holder |
| Standby, actor not granted | `{ok:false, status:403, code:'actor_unregistered' \| 'insufficient_permission'}` — the degraded path applies the config-derived precheck (fail closed; labelled in `authorization`) |

Degraded fallback (VERIFIED): `source:'app-store-fallback'`, `degraded:true`,
`provenance:'unavailable'`, the app-store rows for that business+scope filtered
by a substring match, and a `note` stating that provenance, claims, conflicts and
lifecycle require the brain. **No provenance is ever invented** on this path, and
no brain write happens.

## 6. Attribution (`describeProvenance` + `attribution`)

```js
const provenance = await adapter.describeProvenance({ actor, observation_id });
// { actor: {id, type, display_name}, observed_at, source: {app, source_id, source_ref}, ... }

const { show, line, why } = adapter.attribution({ ...provenance.render, surface: 'staff' });
```

`describeProvenance` reads the canonical evidence record (`readObservationEvidence`)
so the actor and the **registered source** come from the brain, not from your
request. Rendering itself goes through `smartware/render`: staff-facing
attribution defaults on for corrections, conflicts, unverified/failed freshness
and recent changes; client-facing surfaces never show sources or staff names.
VERIFIED: the smoke asserts the actor line renders for `surface:'staff'` and
never for `surface:'client'`.

## 7. Owner operations, lease-routed

`registerSource`, `addClient` (new client ⇒ new `#N` scope via `ensureScopes`),
`exportClientScope`, `forgetClientScope` are pass-throughs that refuse on a
standby (503 + holder) and surface the substrate's codes verbatim on the holder.
`exportClientScope` is scope-exclusive and idempotent per `operation_id`;
`forgetClientScope` is owner-gated and reason-aware (`offboarding` vs
`erasure`).

## 8. Migration (adding the brain to a running Coffee)

The brain is **additive and behind the adapter**, so the rollout is staged and
every stage is reversible:

1. **Provision** (no behaviour change): create one `brain_dir` per business,
   write `config.template.json`-shaped `config.json` with `owner_id`, the
   `workspace`/`self` scopes, one `client:<id>#<n>` per active client, and
   exact-id grants for current staff and agents. `adapter.start()` does this if
   you pass the provisioning object; there is no data migration — the brain
   starts empty.
2. **Shadow writes** (dark launch): call `handleWrite` after your existing write
   path, ignore the result except its `code`/`drift_total`. Watch
   `adapter.health({actor: owner})` and the Coffee-trial SLO verdict. Recall
   stays off.
3. **Owner reads**: enable `handleRecall` for owner-facing/internal surfaces
   only. Read the `source` field: `'app-store-fallback'` means the brain did not
   answer and the host is on the degraded path.
4. **Staff and agent reads**: enable per surface. Attribution goes through
   `adapter.attribution(...)`; the render contract decides what a client sees.
5. **Owner operations**: enable export/offboarding once (2)–(4) are stable.
6. **Retire nothing.** The app store remains authoritative throughout.

Rollback, at any stage:

- **Reads first, writes second**: turn off `handleRecall` per surface, then
  `handleWrite`. Nothing in Coffee's own store changes; the brain simply stops
  being consulted.
- **Stop the adapter**: `adapter.stop()` releases the lease; the `brain_dir`
  stays on disk, intact and inspectable (SQLite + JSONL + config).
- **Revert the package pin** to the previous Coffee release. The brain's data is
  a separate directory and is not touched by a code rollback.
- **Re-entering later**: the brain is still there. Restart the adapter; it
  re-acquires ownership and recall works again. Restore (ADR-0006) is the return
  path after a disaster: `restoreScope` verifies manifest checksums and refuses
  a package that crosses its scope boundary, a non-empty target scope, or a
  tampered package — before writing anything.

## 9. Verification — what to run, and what it proves

```sh
npm run verify:coffee-adapter      # builds, then runs the deterministic smoke
```

53 checks, no network, no Redis, no model key, no sleeps: two businesses with
overlapping client names, two replicas per lease dance, staff + agent + stranger
actors, a contradicting fact, a stalled stale writer (the fence drill), degraded
reads, provenance, export and health. The exact check list is in the script's
header; the run prints one `PASS` line per behaviour and exits non-zero on any
failure.

**VERIFIED by that run** (the full list is the script; highlights): standalone
refusals write nothing; owner writes are recallable with one claim per fact;
restatements corroborate; contradictions stay contested with both sides
surfaced; agents act under their own grants and ungranted scopes are denials;
the standby answers degraded without inventing provenance and fails closed for
unauthorised actors; failover advances the epoch; a stalled stale writer is
refused by the guard (nothing written) and, in the race the guard cannot cover,
by the brain fence before any canonical artifact; two businesses never share a
key; export is scope-exclusive; health carries no tenant content.

**NOT YET PROVEN / out of scope for this cut:**
- Coffee staging or production traffic (staging unavailable) — the ports above
  are the interface you test against staging.
- Cross-replica behaviour under real Redis (the smoke's ports are in-memory
  implementations of the same contract; the pilot measured the Redis-shaped
  paths in the resilience gauntlet).
- The drift counter counts divergences **this process observed**; reconcile from
  the app store to catch the ones it did not.
- No cross-store transaction exists by design; a crash between steps 4 and 6
  leaves an app record whose brain half is replayable with the same
  `operation_id` and is meanwhile counted as drift.
- Storage-level fencing for a pause *inside* one mutation (ADR-0007's stated
  residual).
