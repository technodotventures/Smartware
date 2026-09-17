# Coffee reference adapter

Drop-in integration of Smartware as an additive company-brain memory layer for
Coffee: one brain per business, clients as non-reusable scopes, staff and agents
as authenticated actors with exact-id grants, Redis authoritative, the brain
additive, write routing to the lease holder, retry-safe refusals, honest
degraded reads, and attribution through `smartware/render`.

**The contract is [`docs/integration/coffee-adapter.md`](../../docs/integration/coffee-adapter.md).**
This directory is the code it describes.

| File | What it is |
|---|---|
| `adapter.mjs` | The adapter. Imports only the published package surface (`smartware`, `smartware/layer1`, `smartware/layer1/*`, `smartware/layer3`, `smartware/render`) — no `dist/...` internals, no Redis driver, no model credential. |
| `config.template.json` | A complete Coffee tenant provisioning file: one business, two clients as `client:<id>#<n>` scopes, a staff grant and an agent grant, `llm.provider: 'none'`. |

## Run the proof

```sh
npm run verify:coffee-adapter     # builds, then runs the deterministic smoke
```

`scripts/coffee-adapter-smoke.mjs` exercises the adapter against in-memory
implementations of the two ports: two businesses with overlapping client names,
replica failover with fencing epochs, a stalled stale writer, a contradicting
fact, degraded reads, provenance and export. No Redis, no network, no model
key, no sleeps. It prints one `PASS` line per behaviour and exits non-zero on
any failure.

## Use it

```js
import { CoffeeBrainAdapter, coffeeTenantConfig, newOperationId } from './coffee-adapter/adapter.mjs';

// Provision once per business (writes <brainDir>/config.json if absent).
const tenant = {
  ...JSON.parse(fs.readFileSync('./config.template.json', 'utf8')),
  data_dir: brainDir,
};
const adapter = new CoffeeBrainAdapter({
  tenant, brainDir, instanceId: `inst_${process.pid}`,
  ports: { appStore: yourRedisAppStorePort, arbiter: yourRedisLeasePort },
});
await adapter.start();

// Retry-safe write. Supply operation_id — it is the retry key.
const result = await adapter.handleWrite({
  actor: { type: 'person', id: 'user:gigi', display_name: 'Gigi' },
  client: 'acme',
  text: 'Acme renewal date is 2026-11-02',
  operation_id: newOperationId(),
  claims: [{
    subject: { name: 'Acme', type: 'organization' },
    predicate: 'renewal_date',
    object: { type: 'text', value: '2026-11-02' },
    validity_from: '2026-08-01T00:00:00.000Z',
  }],
});

// Honest reads: check `source` — 'app-store-fallback' means the brain did not answer.
const read = await adapter.handleRecall({ actor, client: 'acme', query: 'Acme renewal' });

// Poll ownership on a timer (leaseTtlMs / 3) and on shutdown.
await adapter.refreshOwnership();
await adapter.stop();
```

Switch `config.template.json` into your repo and replace the two ports with
Redis implementations of
[§2 of the contract](../../docs/integration/coffee-adapter.md#2-what-you-implement-two-ports).

## Environment

Node.js ≥ 22 (the package's engine floor). Nothing else — the adapter adds no
dependency to your project.
