# Security baseline

Smartware is local-first beta software. Its security boundary combines
capability-based protocol authorization with private local filesystem
permissions. Host applications remain responsible for transport, process,
deployment, and user-interface security.

## Dependency status

The launch baseline uses `@modelcontextprotocol/sdk` 1.30 or newer and a patched
`@hono/node-server` transitive dependency. At publication:

```sh
npm audit --omit=dev
```

reports zero production dependency vulnerabilities.

CI runs the production audit on every change. Any new advisory must be reviewed
against both the standalone stdio runtime and any host-provided transport.

## Runtime boundary

- The reference executable uses MCP over stdio and does not open an HTTP
  listener.
- New data directories and sensitive operation-intent files use private local
  permissions.
- Grants are checked before protected reads and writes.
- Sensitive memory is excluded unless the owner explicitly opts in.
- Semantic providers receive only the claim documents eligible for the current
  actor, scope, and request.
- Provider credentials remain host/operator configuration and must not be
  committed to the repository.

## Explicit limits

- Smartware data is not application-level encrypted at rest.
- Local permissions do not protect against malware running as the same user or
  offline disk access without platform encryption.
- Multi-writer synchronization and remote transport security are outside the
  current standalone beta boundary.
- Cryptographic review of the integrity chain and grant model is not claimed.

Report vulnerabilities privately using [SECURITY.md](../SECURITY.md).
