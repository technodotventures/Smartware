# Identifier and scope compatibility

The v0.5.0 JSON Schemas define the canonical wire conventions:

- actors: `user:…`, `agent:…`, `sidecar:…`, or `substrate:…`;
- scopes: `self`, `workspace`, `project:…`, `agent:…`, or the Coffee tenant
  boundary scopes `client:<id>` / `client:<id>#n` (non-reusable markers);
- observations: `obs_<content-hash>`.

New standalone Smartware instances use those conventions. The embedded Core
also accepts host-defined internal identities and scopes so products can map
their own domain language at the adapter boundary.

Evidence and operations remain append-only, actor aliases are forward-only,
and host-defined records are readable through the embedded API. This is an
explicit host-compatibility profile, not a claim that application-defined
records validate unchanged against the frozen wire schemas.

Protocol-facing integrations should emit canonical actor and scope IDs. Product
Adapters may map their own labels to those IDs at the boundary while preserving
the original source identity in provenance.
