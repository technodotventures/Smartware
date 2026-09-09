// Code verification for G2 clients-as-scopes config shape (t_400a42f8)
// Runs against the built dist (npm run build first). Kept as the verification
// record for the config-shape binding; the impl card (t_357cd5fb) can reuse it.
import { checkGrant, isOwner, isSpecConformantActorId } from '../dist/auth/grants.js';
import { ScopeRegistry } from '../dist/scopes/registry.js';
import { loadConfig, saveConfig, createDefaultConfig } from '../dist/config.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

// 1. Actor id pattern checks (common.schema.json ActorId ^(user|agent|sidecar|substrate):[a-z0-9-]+$)
console.log('actor-id user:stevie:', isSpecConformantActorId('user:stevie'));
console.log('actor-id user:stevie-ghiasi:', isSpecConformantActorId('user:stevie-ghiasi'));
console.log('actor-id person_owner (legacy):', isSpecConformantActorId('person_owner'));

// 2. Build the Coffee tenant config shape: one business = one Pod
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-shape-'));
const cfg = createDefaultConfig(tmp);
cfg.owner_id = 'user:stevie';
cfg.scopes = [
  { id: 'self', parent: null, visibility_default: 'private' },
  { id: 'workspace', parent: null, visibility_default: 'workspace' },
  { id: 'client:acme', parent: 'workspace', visibility_default: 'scope' },
  { id: 'client:acme#2', parent: 'workspace', visibility_default: 'scope' },
  { id: 'client:bcau', parent: 'workspace', visibility_default: 'scope' },
];
cfg.grants = [
  { id: 'grant_gigi', actor_type: 'person', actor_id: 'user:gigi',
    capabilities: { observe: ['client:acme#2', 'client:bcau'], query: ['client:acme#2', 'client:bcau'], compile: [], correct: ['client:acme#2'], forget: [], read: ['client:acme#2', 'client:bcau'] },
    trusted: false, quarantine: false, created_at: new Date().toISOString(), expires_at: null, status: 'active' },
];
saveConfig(tmp, cfg);
const loaded = loadConfig(tmp);
console.log('--- config roundtrip ok; scopes:', loaded.scopes.map(s => s.id).join(', '));
const reg = new ScopeRegistry(loaded);
console.log('registry ancestors of client:acme#2:', reg.getAncestors('client:acme#2').join(' > '));

// 3. Grant cluster semantics under this shape
console.log('exact client:acme#2 query:', checkGrant('user:gigi', 'query', 'client:acme#2', loaded));
console.log('exact client:bcau query:', checkGrant('user:gigi', 'query', 'client:bcau', loaded));
console.log('versioned distinctness client:acme (#1 orphan) query:', checkGrant('user:gigi', 'query', 'client:acme', loaded));
console.log('un-granted client:acme query:', checkGrant('user:gigi', 'query', 'client:acme', loaded));

// Emulate scopeMatches (private fn) for cluster-wildcard attempts:
function sm(p, t) {
  if (p === '*') return true;
  if (p === t) return true;
  if (p.endsWith('/*') && t.startsWith(p.slice(0, -1))) return true;
  return false;
}
console.log('emulated client/* vs client:acme#2:', sm('client/*', 'client:acme#2'));
console.log('emulated client:* vs client:acme#2:', sm('client:*', 'client:acme#2'));
console.log('emulated * vs client:acme#2:', sm('*', 'client:acme#2'));
console.log('emulated client:acme#* vs client:acme#2:', sm('client:acme#*', 'client:acme#2'));

// 4. Owner bypass + registry visibility default
console.log('owner isOwner user:stevie:', isOwner('user:stevie', loaded));
console.log('visibility_default client:acme#2:', reg.getVisibilityDefault('client:acme#2'));

// 5. Ship the worked example (§10b.4) through the same code paths
import { readFileSync } from 'fs';
const example = JSON.parse(
  readFileSync('/opt/data/dev-workspaces/repos/smartware/docs/competitive/coffee-tenant-config.example.json', 'utf8'),
);
const reg2 = new ScopeRegistry(example);
for (const s of example.scopes) {
  if (!reg2.get(s.id)) throw new Error(`missing scope ${s.id}`);
}
console.log('--- example: all scope entries resolve:', example.scopes.map(s => s.id).join(', '));
console.log('example owner bypass user:ava:', isOwner('user:ava', example));
console.log('example gigi query client:acme#1:', checkGrant('user:gigi', 'query', 'client:acme#1', example));
console.log('example gigi query client:gate#2 (not in cluster):', checkGrant('user:gigi', 'query', 'client:gate#2', example));
console.log('example noah query client:gate#2:', checkGrant('user:noah', 'query', 'client:gate#2', example));
console.log('example noah read client:acme#1 (read only gate#2):', checkGrant('user:noah', 'read', 'client:acme#1', example));
console.log('example agent observe client:gate#2:', checkGrant('agent:coffee-assistant', 'observe', 'client:gate#2', example));
console.log('example agent query client:acme#1:', checkGrant('agent:coffee-assistant', 'query', 'client:acme#1', example));
console.log('example retired #1 marker unreachable from #2 grants (gate#1):', checkGrant('user:noah', 'query', 'client:gate#1', example));

fs.rmSync(tmp, { recursive: true, force: true });
