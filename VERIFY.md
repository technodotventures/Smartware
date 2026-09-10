# VERIFY.md — acceptance criteria and the definition of completion

> **Nothing is done because it was attempted, or because the agent that did the
> work says it succeeded.** A change is accepted when the gate below passes and
> its output is recorded in `docs/journal/` (or attached to the kanban task).

## The gate

Run from a clean tree. Every line must pass; quote the real output, not a summary.

| # | Command | What it proves | Fails when |
|---|---|---|---|
| 1 | `npm ci` | Locked dependency graph resolves | `package.json` / `package-lock.json` disagree |
| 2 | `npm audit --omit=dev --audit-level=low` | No production advisories | Any prod vulnerability at `low`+ |
| 3 | `npm run build` (`tsc`) | Types are sound across the tree | Type errors |
| 4 | `npm test` (`vitest run`) | Behavioural suite passes | Any test failure |
| 5 | `npm run verify:schemas` | Schema checksums match the published contracts | A schema was edited without regenerating its checksum |
| 6 | `npm run verify:saas` | SaaS integration smoke (build + end-to-end integration path) | Integration surface broke |
| 7 | `npm run status:check` | `docs/STATUS.md` is not a stale projection | Substrate state changed without regenerating the status |

Rows 1–5 run in CI (`.github/workflows/ci.yml`) on the **Node 22 and 24 matrix** for
every pull request and every push to `main` — CI is the authoritative acceptance
gate for this repository, and a local pass that CI rejects is not a pass.

Row 7 is an **agent/operator gate, not a CI job**: it compares `docs/STATUS.md`
against a live regeneration, which needs local git refs and a readable kanban
board. Run it before you close a session and whenever you change anything
`docs/STATUS.md` derives from (`npm run status` first, then `status:check`).
Environmental facts (the working tree's cleanliness at generation time) are
ignored by the comparison; everything else must match.

### Task-specific gates (run when the change touches them)

| Area | Command | Contract |
|---|---|---|
| Retrieval kernel | `npm run benchmark:retrieval-kernel` | `benchmarks/retrieval/kernel-contract-v1.json` |
| Retrieval arena | `npm run benchmark:retrieval-arena` | `benchmarks/retrieval/arena-contract-v1.json` |
| Retrieval activation | `npm run benchmark:retrieval-activation-contract` | Fails **closed** unless held-out evidence clears the gates (`--expect-hold`) |

Benchmark results are evidence, not decoration: a change that moves retrieval
quality or latency must record the previous and new numbers, the machine, and the
run count. "It feels faster" is not evidence.

## Definition of completion

A change is complete when **all** of these are true:

1. The full gate above passes (or the specific failure is named, with its output, and accepted by the operator).
2. The change is attributable — a commit, on a branch, with a subject that says what it changes.
3. The state delta is recorded: `docs/journal/` entry or kanban completion summary containing intent → evidence → resulting state → unresolved implications.
4. Any normative text the change affects (`docs/spec/`, `docs/protocol/`, `schemas/`) is updated **in the same change**, or the divergence is written down as an open question.
5. `npm run status` has been run if the change alters anything `docs/STATUS.md` derives from.
6. Any consequential decision made along the way exists as an ADR, not as a comment.

## Verification independence

- The producer of a change must not be its only verifier when the change touches a
  **released protocol surface**, **acceptance criteria**, or **verification logic
  itself**. Those require a second agent or a human who did not write the change.
- A verifier may not mutate the artifact it verifies. Its output is evidence
  attached to the state transition.
- Self-reported results (agent summaries, generated status text, "tests pass") are
  leads, not proof. Re-run the command or read the artifact.

## Recording evidence

Evidence goes in the session's journal entry in this shape:

```
Gate:   npm run build && npm test        → tsc clean; 443/443 vitest passed
Run:    2026-08-30, 2 vCPU, Node 22.18, n=4
Notes:  <what the numbers mean, what did NOT pass, what remains unproven>
```

If a gate was **not** run, say so explicitly. An unstated unrun gate is the most
common way a multi-agent project accumulates fiction.

## Last recorded full-gate result

| Date | Result | Source |
|---|---|---|
| 2026-08-30 | `tsc` clean · **443/443** vitest passed · full-pipeline compile budget 9,493.5 ms @50k claims (n=4 clean runs, 9,445–9,682 ms) | kanban task `t_b5392e58`, recorded in spec §11.2c |

_This table is a projection of the journal. If it disagrees with
`docs/journal/`, the journal wins — and this table is a bug._
