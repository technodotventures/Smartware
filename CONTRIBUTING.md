# Contributing to Smartware

Smartware is an evolving protocol. Changes should improve observable memory
behavior without weakening provenance, authorization, temporal correctness, or
safe fallback behavior.

## Before opening a pull request

1. Start from `main` and keep the change focused.
2. Add tests that protect the intended protocol behavior.
3. Run:

   ```sh
   npm ci
   npm run build
   npm run verify:schemas
   npm test
   npm run benchmark:retrieval-kernel
   npm run benchmark:retrieval-arena
   npm run benchmark:retrieval-activation-contract
   ```

4. Document compatibility or migration consequences for wire, schema, storage,
   or integrity changes.
5. Do not include user memory, credentials, or proprietary evaluation data.

Retrieval candidates must remain behind the arena and activation gates until
held-out evidence authorizes promotion. Development-set improvements are not
production activation evidence.

## Contribution license

Unless you explicitly state otherwise, a contribution intentionally submitted
for inclusion in Smartware is provided under the Apache License, Version 2.0,
as described in section 5 of that license.
