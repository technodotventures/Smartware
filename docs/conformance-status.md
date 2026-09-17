# Implementation conformance

**Target:** Specification v1.6.16 (five-verb surface), Protocol v0.5.0,
Schemas v0.5.0. The v0.5.0 conformance surface is **the five core memory verbs
(OBSERVE, RECALL, REFLECT, REVISE, FORGET) plus FORGET.SCOPE.**

Smartware is beta software. The repository provides executable evidence for
the implementation boundaries below; it does not claim exhaustive
Specification v1.6.16 conformance.

## Protocol v0.5.0 migration note (NOT a break)

- v0.4.x servers are backward-compatible on the five verbs: every v0.4.2
  semantic and wire invariant of those verbs is preserved unchanged in v0.5.0.
  Existing five-verb client code runs unchanged against a v0.5.0 server.
- v0.4.x servers are **non-conformant on scope-erasure**: they have no
  FORGET.SCOPE and cannot meet its atomicity, same-commit grant revocation,
  exact-count audit, or lane-exhaustive purge requirements.
- The v0.4.2 contract and schema set are retained and remain valid for
  five-verb conformance claims. This is a migration note, deliberately **not**
  a break — the anti-pattern avoided is mem0's v2→v3 churn, where a protocol
  revision broke consumers with no migration path.
- The v0.5.0 contract and the v0.5.0 schema set ship together; a mismatch
  between them blocks conformance until corrected. See the
  [v0.5.0 contract change history](protocol/smartware-protocol-v0.5.0.md).

## Release identity

- The package version is **0.7.0**; `package.json` and `src/version.ts` are kept
  in sync and are the single source of truth for the version string.
- 0.7.0 carries the v0.5.0 protocol surface. The earlier published `0.6.3` on
  the npm registry **predates that surface** and does not contain
  `schemas/v0.5.0`; integrators following the v0.5.0 documentation must not
  pin `0.6.3`.

## Verified baseline

Verified 2026-09-17 on Node v26.5.1 for **the compile/endorse re-serialise of a page the writer
refuses** (`wip/neo/compile-page-refusal` @ `19d5172`, stacked on the still-unmerged
`wip/neo/frontmatter-write-residuals @ a415578`; kanban `t_5742162f` — one shared helper plus two
call sites, so **no published schema byte moves**, `SHA256SUMS` unchanged): **575 tests across 81
files**, 31 schema files. The delta over the entry below is 3 tests in one new file
(`test/layer2/l2-page-refusal-mixed-notices.test.ts`). The independent VERIFY `t_6012c8ca`
Finding 2 measured that the pre-existing mixed-array refusal is **reachable from the reader** — a
hand-authored block array whose item is not a mapping parses to a mixed object/non-object array (a
bare `- ` item → `[{…}, ""]`, a `|-` item → `[{…}, "|-"]`, a nested sequence → `["", {…}]`) — and
that the next COMPILE of such a page threw an unnamed base `Error`; the ENDORSE re-serialise is
reachable the same way (measured). Decided and fixed here (option 3 of the card — keep the loud
refusal and make it explicit; normalising would drop or stringify the user's bytes, against the
entry below's "a loud refusal, not silent flattening", and reader semantics for `-` nested
sequences / `|-` are the reader lane's decision, not this fix's):

- both page re-serialise paths — COMPILE's user-page branch (`src/layer2/compiler.ts`) and the
  ENDORSE cascade (`src/protocol/endorse.ts`) — now serialise through `serialisePageFrontmatter`,
  which raises a named `PageRefusalError` (`page_refused: "<path>" cannot be re-serialised —
  <the writer's own field reason>`) naming the page *and* the field. The write-boundary refusal
  itself is untouched: nothing is dropped, stringified or otherwise normalised, and a refused page
  keeps its bytes exactly as authored (pinned at the byte level for both halves).
- the remedy is stated, not implied: a page carrying a mixed `notices` array fails its next
  compile/endorse until its array is made homogeneous (or the reader lane decides the construct —
  `t_cf744a8e` left nested sequences unread; `t_6fc254cd` owns `|-`), and fixing the value lets
  the same flow proceed (pinned).

Non-tautological: the pin (sha256
`50067424f5c255ebe8701633f212f9a96dd467788602e0ce531fbc075ff989ac`) is **2 failed | 1 passed (3)**
in a worktree at `a415578` with the fix absent (byte-identical pin; the two feature tests fail on
`Error` / no page named / the wrapper not exported; the write-boundary control passes on both
arms) and **3 passed (3)** on the fix. Controls on the compile path: a homogeneous object array
and a bare string array both compile and are carried — the refusal is the *mixed* shape only, no
over-refusal added. Gate: `npm run build` exit 0; focused `test/layer2` **6 files / 36 tests**;
full suite **81 files / 575 tests exit 0** (133 s); `verify:schemas` 31 files OK; `verify:saas`
`SMOKE_OUTCOME=pass`; `npm audit --omit=dev` 0 vulnerabilities. Not run: `npm ci` (shared
`node_modules` symlink policy — CI runs it on Node 22/24).

Verified 2026-09-17 on Node v26.5.1 for **the page YAML serialiser's remaining write-boundary
losses** (`wip/neo/frontmatter-write-residuals` @ `a872f42` plus the `t_15b309f3` text/pin
correction on top — no behaviour change, only the pin, the code comments and this entry; stacked
on the still-unmerged `wip/neo/frontmatter-coercion-depth @ c740511`; kanban `t_0e19036e` — a
writer + guard change in one file, so **no published schema byte moves**, `SHA256SUMS`
unchanged): **572 tests across 80 files**, 31 schema files. The delta over the entry below is 7
tests in one new file (`test/layer2/l2-frontmatter-write-residuals.test.ts`; one stale clause in
the sibling pin's header comment is corrected to match). The independent VERIFY `t_5708fed6` (§4)
measured six shapes still below this boundary — all pre-existing, identical on both arms it
tested — and each is decided here, the guard now refusing every shape the writer cannot carry
back and supporting the one it can:

- a non-string scalar as an **array element** (`meta: [1, 2]`, `['b', true]`, `['a', null]`) was
  written through `String(item)` and read back as a string, and a null *first* item additionally
  raised a raw `TypeError: Cannot convert undefined or null to object` with no field name.
  REFUSED, naming `path[index]` (`page field "meta[0]" holds a number, …`).
- an **array as an array element** (`['b', []], ['b', ['x']]`, and the pure nested sequence
  `[['x']]`) was mangled (`String([])` → `''`; `Object.entries` → `0: …` lines) and never read
  back. REFUSED too — this **supersedes the nested-sequence half of the entry below's "remaining
  limits"**, where it is still written and garbled: the shape is contract-legal only at
  undeclared notice-item keys, which is exactly the class the guard refuses rather than flattens
  (the C2 reasoning of `t_5768425d`). The `|-`/`|+`/`>` half of that sentence still stands and
  stays with `t_6fc254cd`.
- an **empty object item** (`notices: [{}]`) degraded to `''`. REFUSED, naming the item.
- a **multi-line string as an array element** (`aliases: ['a\nb']`) is contract-legal
  (`aliases.items` is a plain string) and was silently destroyed — the writer quoted the element
  across lines and the whole array read back as one string. **SUPPORTED when the element's
  minimum indentation over its non-blank lines is 0** (some line's content starts at column 0 —
  every spelling in the pin, and the whole 5569-row probe corpus): the writer now emits the block
  form (the `- <str>` item form, and the `- |` block form for multi-line elements) that the
  reader has decoded since `t_cf744a8e`'s shape 6, and a hand-authored block-array page is no
  longer corrupted on re-serialise. **Not supported, disclosed and pinned** (VERIFY `t_6012c8ca`
  Finding 1): an **all-indented** element silently loses its own minimum indentation to the
  writer's fixed 4-space prefix plus `readBlockScalar`'s minimum-indent strip — `' a\n b'` reads
  back `'a\nb'`, `'  a\n b'` reads back `' a\nb'` — and the same reset appears at every array
  position the writer emits (the pre-existing `key: |` mapping-value path behaves identically).
  The string is contract-legal and deliberately **not** refused (refusing it would be an
  over-refusal); it is a host-constructed-value loss only — a hand-authored all-indented block
  already loses the indent at *read*, so the compile/endorse re-serialise path cannot re-lose it.

Correction note (`t_15b309f3`, after the independent VERIFY `t_6012c8ca`): the R2 bullet and the
reachability clause above are the corrected text — the fix commit `4a30730` and the first docs
commit `a872f42` stated the SUPPORTED class and the reachability conclusion without the two
qualifiers now named here (the all-indented sub-class; the pre-existing mixed-array refusal being
reader-reachable). Corrected in the same pass: the pin (header comment, the R2 test's measured
resets, the reachability comment), the `frontmatter.ts` comments, the sibling pin's mixed-array
message assertion (`mixes object and non-object items` — an array item is not a scalar) and this
entry. No refusal semantics, no emitted bytes for carriable shapes and no published schema byte
changed: the corrected pin reproduces **5 failed | 2 passed (7)** at `c740511` and **7 passed (7)**
on the fix, and the 5569-row and byte-level re-runs reproduce the numbers quoted here.

Non-tautological: the corrected pin file (sha256
`be19837ad18311f109c4b19388d4d836de8f389b1523563c5e5b11280b239585`) is **5 failed | 2 passed (7)**
in a worktree at `c740511` with the fix absent (the 5 feature pins fail; the 2 controls pass on
both arms) and **7 passed (7)** on the fix; the independent probe's 5569 rows move exactly 208 —
51 `LOSS → PASS` (every one a `S2.aliases_elem` newline string) and 157 `STATUS_MOVED_OTHER` (81
`LOSS_UNEXPLAINED`, 36 `LOSS_nested_sequence`, 19 `LOSS_empty_object_item`, 8
`LOSS_scalar_array_type_change`, 8 `MEASURED_LOSS`, 5 `THREW_UNNAMED` → `GUARDED`, every one
naming a concrete path) — with **0 REGRESSIONS, 0 rows whose read-back moved without a status
move, 0 OVER_REFUSED** (every must-work control still round-trips and validates) and the
compile/endorse re-serialise path unable to hit **the three refusals this lane adds** — the reader
cannot produce them (0/4000 fuzzed hand-authored blocks plus the structural argument; 6/6
`R.reserialise` rows CLEAN). That scoping is load-bearing, per VERIFY `t_6012c8ca` Finding 2: one
**pre-existing** refusal *is* reachable from the reader — a mixed scalar/object array
(`parseBlockArray` yields one whenever a block-array item is not a mapping; 3 named blocks,
12/4000 fuzzed) — and on the real COMPILE path the next re-serialise throws end-to-end,
identically on both arms; the behavioural half is carded as `t_5742162f` (fixed in the entry
above), not this lane. A
byte-level re-run of the same corpus shows emitted frontmatter
byte-identical on 5256 rows; every byte change is on a row whose status moved, plus one row
(`'a\n \nb'`) whose status was and stays LOSS. Remaining at this tip: that string loses the space
on its whitespace-only line at four positions — pre-existing reader behaviour (`readBlockScalar`,
identical on both arms; the C4 half of `t_6fc254cd`, not in this ancestry) — `tags: ['123']`
still fails the published `Tag` pattern (a contract refusal, not a serialiser defect), and the
all-indented multi-line array element above (`' a\n b'` → `'a\nb'`) stays a silent
host-constructed-value loss (measured reset, pinned in the pin's R2 test; not refused; not
reachable from a parsed page — VERIFY `t_6012c8ca` Finding 1). Gate:
`npm run build` exit 0; focused `test/layer2` **5 files / 33 tests**; full suite **80 files / 572
tests exit 0** (151 s); `verify:schemas` 31 files OK; `verify:saas` `SMOKE_OUTCOME=pass`;
`npm audit --omit=dev` 0 vulnerabilities. Not run: `npm ci` (shared `node_modules` symlink policy
— CI runs it on Node 22/24).

Verified 2026-09-17 on Node v26.5.1 for **the page YAML serialiser's coerced scalars and the
guard's value positions** (`wip/neo/frontmatter-coercion-depth @ 7ef9ab0`, stacked on the
still-unmerged `wip/neo/frontmatter-lossy-shapes @ b10c77c`; kanban `t_5768425d` — a writer +
guard change in one file, so **no published schema byte moves**, `SHA256SUMS` unchanged): **565
tests across 79 files**, 31 schema files. The delta over the entry below is 15 tests in two new
files — this lane's 7 in `test/layer2/l2-frontmatter-coercion-depth.test.ts` and the t_cf744a8e
lane's 8 in `test/layer2/l2-frontmatter-lossy-shapes.test.ts`. Two shapes a contract-legal page
could still hit were measured lossy at `b10c77c` by the independent VERIFY `t_3e511c55` (rows
A3a–A3d and A2b, its §8 "two shapes the decision does not enumerate") and fixed here:

- a numeric/boolean/null-looking **string** at a bare `type: string` (`summary: "123"`, `"1.50"`,
  `"true"`, `"null"`, the `0x10`/`1e3`/`Infinity`/`007`/`.5`/`5.` spellings) was written unquoted
  and read back as another type, so the page failed its own published contract (`/summary:type`)
  after a write it made itself. Fixed: the writer quotes any spelling the reader's coercion would
  change; `isCoercedScalar` is shared by reader and writer so the two cannot drift. A
  hand-authored bare `summary: 123` is still read as a number — the contract reports it loudly.
- a **nested object deeper than one level inside a notice item**
  (`notices[0].links = [{url, meta: {a: 'b'}}]`) was neither refused nor preserved (the reader
  flattens `meta` into the links item). Fixed: `assertPageVocabulary` walks every value position —
  an object at any *property* position, at any depth, is refused naming the path (`page field
  "notices[0].links[0].meta"`), and a mixed scalar/object array (previously written through
  `String(item)` as `[object Object]` / `0: a` lines) is refused too. Note for integrators: the
  refused C2 input is **contract-legal** per the published schema (notice items carry no
  `additionalProperties: false`), so this guard is deliberately **stricter than the published
  contract** at undeclared item keys — where the contract allows a key the minimal serialiser
  cannot carry, the honest failure is a loud refusal, not silent flattening.

Non-tautological: the 4 feature pins fail 4/4 on `b10c77c` (`Test Files 1 failed | 3 passed (4)`,
`Tests 4 failed | 22 passed (26)` — the 3 pre-existing layer2 files pass) and pass 4/4 on the fix;
the lane's probe goes 24 SILENT_LOSS → 0 (final 31 PASS / 7 GUARDED / 1 MEASURED), and the
reviewer's own probe re-run against the fix build flips exactly A3a–A3d (→ PASS) and A2b (→
GUARDED) with no other row moved. Gate: `npm run build` exit 0; focused `test/layer2` 4 files / 26
tests; full suite 79 files / 565 tests exit 0 (130.97 s); `verify:schemas` 31 files OK;
`verify:saas` `SMOKE_OUTCOME=pass`; `npm audit --omit=dev` 0 vulnerabilities. Not run: `npm ci`
(shared `node_modules` symlink policy — CI runs it on Node 22/24). Remaining limits of the same
serialiser, pre-existing and carded onward (`t_6fc254cd`): a nested **sequence** item (`[["x"]]`)
is still written as `0: …` lines and garbled on read, and the `|-`/`|+`/`>` block styles are
still not read; both are recorded in the code comment on the fix.

Verified 2026-09-17 on Node v26.5.1 for **the L2 page `notices` array through the hand-rolled page YAML
serialiser** (`fix/tech-head/notices-frontmatter-roundtrip`, stacked on the still-unmerged
`wip/tech-head/l2-page-frontmatter-schema @ 5a1c58c`; kanban `t_4d84ff6b` — a writer + reader fix in one
file, so **no published schema byte moves**, `SHA256SUMS` unchanged): **550 tests across 77 files**, 31
schema files. The delta over the entry below is 6 tests in one new file,
`test/layer2/l2-notices-frontmatter-roundtrip.test.ts`. Spec §9 / `page-frontmatter.schema.json` declare
`notices` as an array of objects (the slot a *user-authored* page carries its notice in); the serialiser
emitted that branch with the item's indent left inside the dash line (`-     type: staleness`, the
continuation keys at a *shallower* column) and the parser read every dash line as a **string**, so
`parse(serialise(fm))` returned `notices: ["type: staleness"]` and pushed `message`/`posted_at` out as
stray top-level keys — which the frozen contract rejects on `additionalProperties: false`. Measured by the
`t_8d6f4a5c` reviewer at `5a1c58c` (5/7 probe checks); the fix makes the writer emit standard block YAML
(`- key: value`, continuation keys at the item's content column) **and** the reader decode mapping items,
including the mis-indented bytes the old writer left on disk, so a page already written by the broken
writer is recovered on read and converges on its next write. Non-tautological: the pin fails 6/6 on
`5a1c58c` (`Test Files 1 failed (1) | Tests 6 failed (6)`) and passes 6/6 on the fix; the last test drives
compile → ENDORSE → notice attached to the user's own page → **recompile** through the real compiler and
asserts the notice survives with an empty Ajv error list. Gate: `npm run build` exit 0;
`test/layer2` + `f_l2_voice_protection` + `g_endorsement` 4 files / 24 tests; full suite 77 files / 550
tests exit 0 (82.06 s); `verify:schemas` 31 files OK; `verify:saas` pass; `npm audit --omit=dev` 0
vulnerabilities. Not run: `npm ci` (the worktree symlinks the shared `node_modules`, so a reinstall would
hit every sibling lane — CI runs it on Node 22/24). **This entry also corrects the entry below** on one
clause: it states a user page's `notices` is preserved verbatim through a rewrite — the frontmatter field
was carried by both writers, but the serialiser corrupted it on the way to disk. Measured after the fix,
four neighbouring shapes of the same minimal serialiser still degrade (a multi-line string anywhere, a
nested object inside a notice item, a single inline-array element containing a comma) — all pre-existing,
all latent (no in-tree verb writes one), none in this card's scope, carded as `t_cf744a8e`. No published
schema byte, `SHA256SUMS` line, or spec/protocol text moves with this change.

Verified 2026-09-16 on Node v26.5.1 for **the compiled L2 page frontmatter against
`page-frontmatter.schema.json`** (`wip/tech-head/l2-page-frontmatter-schema`, stacked on the ADR-0013 lane
`wip/smarty/canonical-schema-boundary @ 6ed7a93`; kanban `t_8d6f4a5c`, ADR-0013 → D2 — a **writer** fix, so
**no published schema byte moves**, `SHA256SUMS` unchanged): **544 tests across 76 files**, 31 schema
files. The delta over the entry below is 3 tests, all in `test/layer2/l2-page-frontmatter-boundary.test.ts`,
whose assertions **inverted**: the compiled page's raw frontmatter now validates with an **empty** error
list where it previously rejected with exactly 19 (`required` ×2 — `created`, `epistemic_tag`;
`additionalProperties` ×12; `/category:enum`, `/sources/0:pattern`, `/updated:format`,
`/confidence:type`, `/confidence:enum`), and the same file now also pins the **endorsed** page (ENDORSE is
a second writer of this artifact), the voice-protected surface across a recompile of an endorsed page
(prose, locked `sources`, `created`, endorsement metadata — driven through the real compiler), and the
pre-fix read path. The writer emits spec §9's field set verbatim;
the compile envelope (`entity_id`, `entity`, `type`, `sensitive`, `compiled_at`, `compiled_by`, `model`,
`supersedes`, `related`, and ENDORSE's recovery metadata) renders into the page's derived **Evidence
Timeline** region as a `smartware-envelope` block instead of into the frozen contract, and READ derives
sensitivity from L1 and resolves entity → page from the L1 entity record rather than from removed
frontmatter. A/B with one probe over both revisions: 19 errors at `6ed7a93` → 0 errors at the fix, and the
old pin passes at `6ed7a93` (2/2) while failing loudly at the fix (1 failed | 1 passed) — the inverted pin
is not tautological. Pages already on disk are read through the compatibility accessor
(`src/layer2/envelope.js`) and upgraded deterministically in place on their next compile or endorsement;
no user prose, locked `sources`, `created`, or user `tags`/`aliases`/`notices` is rewritten. Not covered:
the page `scope` value is the substrate's own string, so a page in a scope outside the v0.5.0 `Scope`
pattern stays an ADR-0015 boundary rather than a page-vocabulary claim. Fixtures in
`f_l2_voice_protection`, `g_endorsement` and `demotion-durability` moved to the published vocabulary;
`e2e/smoke` and `protocol/query` assert the published fields. No other suite changed.

Verified 2026-09-15 on Node v26.5.1 for **which artifact each published schema covers** — the L0
evidence record and the compiled L2 page frontmatter (`wip/smarty/canonical-schema-boundary`, kanban
`t_0920aa1d`, ADR-0013 — schema/contract accuracy plus a disclosed boundary; **no published schema byte
moves**, `SHA256SUMS` unchanged): **541 tests across 76 files** (540 passed; the single failure is
`mcp_smoke`'s 10 s stdio-transport hook under a load average of 23–27 with five sibling lanes running
vitest — re-run alone on the same tree: 4/4 pass, exit 0), 31 schema files. The delta over the entry below is 4
tests in two new files — `test/layer0/l0-record-wire-boundary.test.ts` (2) and
`test/layer2/l2-page-frontmatter-boundary.test.ts` (2) — which pin, for the first time, which schema
belongs to which artifact: no `src/` file referenced either schema, and no normative text assigned one
to a surface (the contract prints the OBSERVE payload in prose without naming `observation.schema.json`,
and mentions `page-frontmatter` only in its Scope-vocabulary list). Measured on the
protocol-native flow (`observe → reflect → compile → exportScope`, raw bytes + Ajv 2020):
`observation.schema.json` accepts the contract's OBSERVE payload plus the stamped identity and rejects
the on-disk **record envelope** by construction (4 `required`, 9 `additionalProperties`,
`/source:type` — the record's nested `source`, `status`, `visibility`, `version`, `policy` and
`integrity` chain have no place in a closed wire schema), **including the byte-identical copies
`EXPORT.SCOPE` ships in `observations.jsonl`/`evidence.jsonl` while its manifest declares
`"schemas": "v0.5.0"`**; `page-frontmatter.schema.json` accepts the spec §9 projection of the frontmatter
the compiler itself writes and rejects the raw form with 19 errors (2 `required`, 12
`additionalProperties`, `category` enum, `sources/0` pattern, `updated` format, `confidence`
type+enum), so there the writer is the side that is wrong. Both divergences are **disclosed** in
`schemas/v0.5.0/README.md` → *Which schema covers which surface*, not silently relaxed; the two fixes
(the L2 page writer, and a published record schema plus an honest export-manifest label) are carded with
their measured evidence (`t_8d6f4a5c`, `t_f1157ed4`). No other suite changed.

Verified 2026-09-15 on Node v26.5.1 for the **substrate ActorId and the host-lane scope disclosure**
(`wip/neo/host-lane-identity`, kanban `t_9a700aed`, ADR-0015 — a writer-identity fix plus a stated
conformance boundary; no schema byte moves, `SHA256SUMS` unchanged): **537 tests across 74 files**, 31
schema files. The delta over the entry below is 5 tests — a new `test/layer1/pod-profile-conformance.test.ts`
(4: the pod-profile record's complete Ajv error list is exactly `["/scope:pattern"]` with a conformant
actor id equal across claims and operations-log entries, the protocol-native control record's list is
empty, reflect.auto and dream carry the same `substrateActorId`, and the slug rule for named/ULID
instances) and one fixture in `test/schemas-v0.5.0.test.ts` (host-lane spellings are not `Scope`
values) — while `test/semantic-materialization.test.ts` substitutes only the scope now, because the
actor id it used to substitute is written conformant. One instance now mints exactly one substrate
identity (`substrate:<slug>`; `smartware_coffee` → `substrate:coffee`), where reflect.auto / the
compile queue previously wrote `substrate:<ULID>` (uppercase, rejected by the published pattern) and
`dream` a second spelling. `pod/<pod>/<lane>` scopes are disclosed as **host-registered lanes** outside
the v0.5.0 `Scope` vocabulary and the schema-conformance claim (see *Remaining limits*). Mutation
checks: reverting the writer mint fails 4 tests; widening the Scope pattern to admit host lanes fails
the new closed-vocabulary fixture. No other suite changed.

Verified 2026-09-15 on Node v26.5.1 for the **claim record's extraction materialization block**
(`wip/tech-head/claim-record-semantic`, kanban `t_229601e4`, ADR-0011 — schema/contract accuracy, not a
protocol change): **532 tests across 73 files**, 31 schema files, `claim.schema.json` the only schema
file changed (`SHA256SUMS` regenerated; the required set and every other property are unchanged). The
delta over the entry below is 2 tests — a fixture group in `test/schemas-v0.5.0.test.ts` (the block is
optional, closed, and required-field-complete when present) and one test in
`test/semantic-materialization.test.ts` (the records `reflect.auto` appends validate against the
published schema) — plus the pinned `test/layer1/legacy-operation-id.test.ts`, which now asserts the
**whole** Ajv error list of the record `insertClaim` appends is empty instead of pinning the known
divergence (same test count). `claim.schema.json` now enumerates the optional `semantic` block, so an
active record the reference implementation writes is accepted by the contract it publishes; the block
is optional, not a wire field, and no conformance claim depends on it. Two same-class divergences were
measured while deciding this and stay open, carded with their evidence (ADR-0011 → *Known
divergences*): `insertClaim`'s forgotten path omits `supersedes` that the schema's forgotten branch
requires (`t_3ba3ee39`), and pod-profile records carry `pod/<pod>/<lane>` scopes and
`substrate:<ULID>` actor ids the v0.5.0 `Scope`/`ActorId` patterns reject (`t_9a700aed` — both halves
settled in the entry above: the ActorId defect fixed in the writers, the host-lane scope disclosed as
outside the v0.5.0 `Scope` vocabulary, ADR-0015). No other
suite changed.

Verified 2026-09-15 on Node v26.5.1 for the **L1 record writer's legacy OperationId**
(`wip/smarty/l1-legacy-op-id`, kanban `t_85817375`): **530 tests across 73 files**, 31 schema files, no
schema file changed (the `OperationId` pattern is unchanged). The delta over the baseline below is 6
tests in one new file (`test/layer1/legacy-operation-id.test.ts`), which drives `insertClaim` with no
caller operation id, validates the written L1 record against `schemas/v0.5.0/claim.schema.json`, and
pins the marker to the one `src/layer1/tombstone-backfill.ts` stamps on a pre-A3 row's tombstone (the
writer fixed in the entry below). The placeholder was `op_LEGACY00000000000000000000`, whose `L` the
published Crockford-base32 pattern rejects; it is now `op_000000000000000000000000A3`. One Ajv error
remains on such a record — the internal `semantic` block the published claim schema does not enumerate
— measured, unchanged by this fix, and carded separately; **that second half was decided in the entry
above** (the schema enumerates the block, and the pinned test now asserts an empty error list). No
other suite changed.

Verified 2026-09-15 on Node v26.5.1 for the **tombstone backfill writer**
(`wip/neo/tombstone-backfill-writer`, kanban `t_9e124fe6`): **524 tests across 72 files**, 31 schema
files. The delta over the baseline below is 3 tests in one new file
(`test/layer1/tombstone-backfill.test.ts`), which drives the only in-tree writer of
`wiki/tombstones/*.md` over legacy-shaped rows (`status: 'retracted'`, no `operation_id`/`actor_id`)
and validates the written frontmatter against
`schemas/v0.5.0/tombstone-frontmatter.schema.json`; the writer now emits the snapshot envelope fields
the schema requires (`claim_id`, `state`, `epistemic_owner`, `fingerprint`), buckets `confidence`
through `confidenceToBucket`, stamps schema-valid `operation_id`/`actor_id` placeholders for a pre-A3
row, and carries a mechanical demotion into the snapshot; no other suite changed.

Verified 2026-09-15 on Node v26.5.1 for the tombstone schema's coverage of the claim record
envelope (`wip/smarty/tombstone-snapshot-envelope`, kanban `t_2bba749f` — schema/contract accuracy,
not a protocol change): **521 tests across 71 files**, 31 schema files. The delta over the baseline
below is 2 tests, both in `test/schemas-v0.5.0.test.ts` (a tombstone-frontmatter fixture group for
the demotion/release fields in the `snapshot` block, and a guard that the block mirrors
`claim.schema.json` field-for-field); no other suite changed.

Verified 2026-09-15 on Node v26.5.1 for the mechanical demotion's **release** vocabulary —
`REVISE` with `repick_survivor` (`wip/neo/repick-survivor`, kanban `t_1db21462`, ADR-0003 →
*Releasing a demotion*): **519 tests across 71 files**, 31 schema files. The delta over the
2026-09-14 baseline below is 12 tests — `test/protocol/repick-survivor.test.ts` (11: swap,
stability, rescue, multi-copy demotion, the two rejections, the two crash legs, the torn-set
fail-closed case, plus rebuild-equivalence assertions) and one schema fixture group in
`test/schemas-v0.5.0.test.ts` (the `repick_survivor` form and the demotion record fields) — and no
other suite changed.

Verified 2026-09-14 on Node v26.5.1 for the duplicate-claim-identity change
(`fix/duplicate-claim-recipe`), the demotion-durability fix on top of it
(`wip/neo/demotion-durability`), and the carry-forward of a demotion through the
flows that hand-build a version record (`wip/smarty/demotion-handbuilt-records`),
superseding the 2026-09-10 0.7.0 release-cut baseline (which recorded **446 tests
across 64 files**): **507 tests across 70 files**, 31 schema files. The delta over
the parent commit is 6 tests — `test/layer1/demotion-durability.test.ts` (4:
`REVISE`, `FORGET` → `REVIVE`, endorsement, consolidation), plus one each in
`test/protocol/forget-scope.test.ts` (offboarding) and
`test/protocol/retention-expire.test.ts` (expiry) — and the eight
demotion-durability tests of the parent change are all still green; no other suite
changed. The retrieval-kernel contract (9/9 scenarios) and the activation contract
(fails closed) were last measured on the parent revision of this baseline; this
change touches Layer 1 version records only, not the retrieval kernel or the
extractor. (CI re-runs the same gate via `npm ci` from `package-lock.json` on Node
22 and 24, so the two runtime lines are verified by CI rather than by this local
run.)

- The TypeScript package builds cleanly (`tsc`; npm run build, no errors).
- All 16 v0.5.0 schemas compile and match the committed checksum manifest
  (`npm run verify:schemas`: 16 v0.5.0 files OK); the retained v0.4.2 set
  (15 files) still verifies.
- The standalone suite passes **524 tests across 72 files** with no skips.
- The fact-identity suite (`test/layer1/fact-identity.test.ts`, 22 tests) pins the
  claim write-path identity contract documented in the integration guide §1e:
  `ClaimStore.findActiveFactMatches` returns **every** active claim asserting a
  fact (survivor order — lexicographically smallest claim id, i.e. earliest-minted
  ULID first) and `resolveFactMatches` folds duplicates into that survivor by
  unioning the losers' `supporting_evidence`, demoting them (`status:
  'superseded'`, `superseded_by`, timestamped, never deleted), recomputing
  confidence with the library formula, and reporting `ambiguous_matches` /
  `superseded_claims`. Both insertion orders of a duplicate pair yield the same
  survivor; a demoted duplicate is no longer matched, **and the demotion is
  durable**: it is recorded in the demoted claim's own canonical version records
  (`superseded_by`, `superseded_at`) and every materialisation derives the row
  from them, so a compile-path row sync and a full canonical replay both keep the
  duplicate out of the recall-eligible set (previously projection-only — measured
  in `t_15bb0cd0` `evidence/23-demotion-durability.txt`; pinned by
  `test/layer1/demotion-durability.test.ts`, which now also covers the flows that
  hand-build a version record). The same 6 fixtures as the
  host-side pilot reference implementation are reproduced 1:1, so the pilot's
  deterministic suite remains a valid cross-check.
- The same suite pins the **known divergence between that write-path identity and
  the pre-existing structured claim fingerprint** (`computeStructuredClaimFingerprint`,
  `reflect.auto` idempotency, spec §193/§238) in both measured directions: two
  active rows differing only in `claim_type` are one fact to the write path and two
  to the fingerprint, while two rows differing only in text case are the reverse.
  The divergence is recorded, unreconciled, with a reversal trigger in
  [ADR-0003](adr/0003-claim-fact-identity.md) → *Known divergence*; reconciliation
  needs owner sign-off. Re-closing it silently fails the suite (measured: dropping
  `claim_type` from the fingerprint fails 1 test, case-folding a text value in
  `normaliseValue` fails 3, making fact identity depend on `claim_type` fails 1).
- `npm run verify:saas` (public-API smoke) exercises the same contract end to end
  against the packaged surface: a store seeded with two active claims for one fact
  answers **2** recall results for that fact and **1** after
  `resolveFactMatches`, with the duplicate superseded, its evidence unioned
  (2→3 refs), survivor confidence formula-consistent, and the two rows for the one
  fact shown to carry two different `canonicalKey`s (the key includes
  `validity_from`, so it is not the fact identity).
- The G3 provenance-rendering contract suite (`test/render/provenance-rendering.test.ts`,
  33 tests) asserts the spec §10d wording table verbatim — flagship
  "Learned from Maya, May 12; corrected by owner May 13.", badge set
  (New / Not verified / May be stale / Conflict / Unconfirmed), the
  default-on predicate truth table (unverified/FAILED freshness, failed
  compile state, stale/contested/low-confidence, consequential
  types/tags, 14d recency + 30d correction windows, custom-window
  honoring), the client-facing denial matrix (only client-owned
  "From your messages" citation; no staff identity, badges, or
  why-panel), and UTC date determinism — via the reference renderer
  `src/render/provenance.ts` (importable as `smartware/render`).
- The G2 v0.5.0 conformance suite (`test/conformance/v050-rebuild-forget-provenance.test.ts`,
  14 tests) asserts, against wipe-clean REBUILT indexes: (a) byte-level
  rebuild-equivalence — canonical JSONL (evidence/claims/operations) is
  bit-identical after wipe-and-rebuild and every canonical line round-trips
  its own bytes; (b) FORGET.SCOPE `erasure` yields zero results in every lane
  (claim FTS, page FTS, raw-observation window, recall, vector store, graph)
  and stale-FTS "ghost" rows are eliminated by regeneration, not merely
  hidden; (c) erasure vs offboarding semantics — exact pre-mutation counts,
  one ops entry, same-commit grant revocation, non-reusable `client:<id>#n`
  markers; (d) provenance integrity — every recall hit resolves its source
  observation + ops entry, superseded claims never satisfy recall/get, and
  multi-version history is order-correct, including on rebuilt state.
- The Coffee company-brain e2e suite (`test/conformance/coffee-company-brain.test.ts`,
  3 tests) proves the multi-actor product flow on the real core (spec §10b/§10c/§25):
  one business = one tenant; owner admin; clients as scopes under `workspace`
  with `visibility_default: 'scope'`; staff granted per exact client cluster;
  a staff member builds a client's company brain and the owner recalls it scoped
  to that client with no cross-client leakage; EXACT grant clusters (Gigi → Acme,
  never Bcau/Gate/`*`; owner bypasses grants); and EXPORT.SCOPE is exactly one
  client — `scope_exclusive: true`, zero cross-client ids in the package, per-client
  packages distinct, and idempotent by `operation_id`.
- Tests exercise OBSERVE, RECALL, REFLECT, REVISE, FORGET, REVIVE, ENDORSE,
  FORGET.SCOPE (erasure and offboarding lanes, owner-only enforcement,
  same-commit grant revocation, exact retraction counts, idempotent retry,
  crash recovery), access control, sessions, context delivery, retrieval
  eligibility, reflection receipts, recovery behavior, and the v0.5.0 schema
  surface (widened Scope pattern, `forget.scope` ops entries,
  forget-scope-request payloads).
- The packed package exposes the embedded `SmartwareCore`, the side-effect-free
  MCP adapter (including `smartware_forget_scope` and `smartware_export_scope`),
  the CLI, and both frozen
  schema sets (v0.5.0 current; v0.4.2 retained).
- The stdio MCP transport is exercised end to end.
- The nine-scenario retrieval-kernel contract passes with zero forbidden hits.
- The activation contract fails closed on public development evidence, as
  required.
- `npm audit --omit=dev` reports zero production dependency vulnerabilities.
  This required a lock refresh in the 0.7.0 cut: the pre-0.7.0 lock still
  resolved `fast-uri@3.1.5`, `hono@4.13.0`, and `qs@6.15.3`, each covered by
  published advisories (1 high, 2 moderate). The fix moved exactly those three
  transitive packages to `3.1.7`, `4.13.7`, and `6.16.0` within their parents'
  existing semver ranges — no direct dependency, protocol, or source change.

Host products must separately test their adapters, transports, persistence,
and user-facing authorization against the exact Smartware version they ship.

## Crash-recovery boundary

Operation-ID-backed OBSERVE, REVISE, FORGET, REVIVE, ENDORSE, automatic
REFLECT, and FORGET.SCOPE claim writes persist a content-free expected-artifact
intent before canonical mutation. (A `REVISE` re-pick commits **two** version
records — the release and the demotion(s) — as one exact artifact set: the
records land in one append, and recovery commits only when every named artifact
is present.)

Startup recovery:

- commits only a complete, exact, hash-valid artifact set;
- leaves exact partial client operations resumable;
- safely discards an unmaterialized internal `reflect.auto` intent so
  deterministic reflection can retry;
- removes stale intents after finding their exact commit;
- leaves every mismatch untouched in `requiresManualReview`;
- finalizes a FORGET.SCOPE only when its L0 audit marker exists — the marker is
  written LAST, after every physical mutation and the config save, so a crash
  before it leaves the operation pending (the retry re-runs the idempotent
  purge) and a crash after it proves the purge already happened.

The exact ordering and recovery state table are documented in
[atomicity.md](atomicity.md).

## Remaining limits

- **The L0 evidence record's field shape is not published in v0.5.0.** `observation.schema.json` covers the
  observation object *on the wire* (the OBSERVE payload plus the stamped identity), not the record the
  substrate appends to `<data_dir>/evidence/<date>.jsonl` — which carries the same information under
  different names plus `status`, `visibility`, `version`, `policy` and the `integrity` chain, none of
  which a closed wire schema can hold. **This includes the copies `EXPORT.SCOPE` ships** in
  `observations.jsonl` / `evidence.jsonl`, in a package whose manifest declares `"schemas": "v0.5.0"`.
  An integrator validating raw evidence — or a third-party implementation claiming v0.5.0 — has no
  published contract for the record until the carded record schema lands (`t_f1157ed4`). Disclosed in
  `schemas/v0.5.0/README.md` → *Which schema covers which surface*; decided in
  [ADR-0013](adr/0013-which-schema-covers-the-l0-record-and-the-l2-page-frontmatter.md); pinned by
  `test/layer0/l0-record-wire-boundary.test.ts` (the record envelope, the wire projection validating,
  the record's exact 14-error rejection, and the export package carrying the same bytes).
- **The reference implementation's compiled page frontmatter does not yet validate against
  `page-frontmatter.schema.json`** — 19 Ajv errors (`created`/`epistemic_tag` missing, plural `category`,
  ISO `updated`, numeric `confidence`, observation ids under `sources`, plus the compile envelope). The
  schema is the contract for that artifact (spec §9 prints the same field set); the writer fix is carded
  (`t_8d6f4a5c`), disclosed in the same README section, and pinned by
  `test/layer2/l2-page-frontmatter-boundary.test.ts`.
- **Host-registered lanes are outside the v0.5.0 `Scope` vocabulary.** The reference implementation's
  pod-profile helper registers `pod/<pod>/<lane>` ids — a host's own lanes, and the live Pod product's
  scope ids — and the published vocabulary admits no host-lane form. A canonical record written in a
  host lane therefore does not meet this contract's conformance boundary ("schema validity on every
  canonical write"); hosts that need v0.5.0 schema-conformant records write protocol-native lanes
  (`self` / `workspace` / `project:<slug>` / `agent:<slug>` / `client:<id>[#n]`). Decided, with the
  measured evidence and the recommendation to define a host-lane form in a later protocol revision:
  [ADR-0015](adr/0015-host-registered-lanes-and-the-substrate-actor-id.md). Pinned by
  `test/schemas-v0.5.0.test.ts` (the vocabulary rejects host lanes) and
  `test/layer1/pod-profile-conformance.test.ts` (a pod-profile record's only Ajv error is
  `/scope:pattern`; a protocol-native record's complete error list is empty).
- Legacy direct calls without an operation ID are outside the recovery
  guarantee.
- Automatic quarantine is not implemented; ambiguous append-only artifacts
  remain available for manual review.
- Duplicate-claim convergence is **host-triggered**, not automatic: an existing
  store keeps two active claims for one fact until a write touching that fact
  resolves them or the host sweeps the scope (`ClaimStore.findActiveFactMatches`
  + `resolveFactMatches`, integration guide §1e). Identity is
  `(subject, predicate, scope, object value)` — the same fact asserted in two
  different scopes is never merged.
- The demotion is durable **from the version that records it** — a compile-path
  row sync and a canonical replay both reconstruct it from the claim's canonical
  version records — and **every flow that hand-builds a claim's next version
  record carries it forward**: user `REVISE` (whose result reports `superseded_by`,
  because a revise changes metadata and not the asserted fact), the `FORGET`
  tombstone, `REVIVE`'s restore from the snapshot, the endorsement cascade,
  consolidation's input tombstones, scope offboarding and retention expiry. One
  limit remains: a demotion written before this fix was projection-only and is not
  reconstructible from canonical data. **Releasing a demotion is a user-only
  re-pick** — `REVISE` with `repick_survivor: true` on the demoted duplicate
  (protocol v0.5.0, shipped 2026-09-15): one atomic commit releases the duplicate
  and demotes the fact's current active copy with a `superseded_by_origin: 'user'`
  warrant, so exactly one copy stays recall-eligible. It works in swap mode (the
  survivor is active) and rescue mode (the survivor is already forgotten — the
  fact returns from audit-only visibility). `invalidate_relations` still cannot
  release one (the demotion is deliberately not an edge); a bare release remains
  unstable and is rejected as a design. Reasoning and the rejected alternatives:
  [ADR-0003](adr/0003-claim-fact-identity.md) → *Carry-forward across hand-built
  version records* and *Releasing a demotion*.
- **Two identity rules over the claim table are unreconciled.** The write-path
  identity above governs the host write path; the autonomous-creation path
  (`reflect.auto`) is idempotent on the structured claim fingerprint instead
  (`claim_type` included, text lowercased), and `insertClaim` stamps that
  fingerprint on every claim when the store has a `data_dir`. A host running both
  surfaces over one store can therefore end up with a duplicate the write path would
  have merged, or a merge the compile path does not see. Recorded with the measured
  cases and a reversal trigger in
  [ADR-0003](adr/0003-claim-fact-identity.md) → *Known divergence*; reconciling the
  two is protocol identity semantics and needs owner sign-off. One legacy artifact
  picks a side rather than inventing a third rule: a backfilled tombstone snapshot
  (`wiki/tombstones/*.md` for a pre-A3 `status: retracted` row) recomputes the
  **content form** — the snapshot block enumerates neither the structured assertion
  nor `semantic`, so a structured value would not be re-derivable from the artifact
  whose purpose is reconstruction (`t_9e124fe6`, ADR-0003 → *Known divergence*).
  (Deliberately unchanged by `t_229601e4` / ADR-0011: the L1 *record* now enumerates
  the materialization block, the snapshot block still does not — its promise is the
  claim schema's **required** fields, and the block is optional.)
- The suite does not prove concurrent multi-writer serialization or universal
  sudden-power-loss durability.
- REFLECT page output and search databases are rerunnable projections rather
  than one transaction spanning the entire compilation run.
- FORGET.SCOPE `erasure` is unrecoverable by design (physical purge); the
  owner-approved non-PII pointer path exists only for `offboarding`.
- Passing schemas and behavioral invariants is not an exhaustive
  requirement-by-requirement proof of Specification v1.6.16.

## Accurate release claim

The tested beta boundary is:

> Idempotent, crash-consistent local mutation commits that recover after one
> process terminates and the operation is retried, plus reason-aware scope
> erasure/offboarding with lane-exhaustive purge, same-commit grant
> revocation, and exact-count audit on the scope boundary.

Smartware must not be described as providing general ACID filesystem
transactions, automatic repair of ambiguous memory, concurrent multi-writer
safety, a single fact-identity rule across its write and compile paths, or full
Specification v1.6.16 conformance.
