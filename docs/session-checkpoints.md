# Session Checkpoint Contract

**Status:** available since Smartware v0.6.1.

Session checkpoints use the existing `OBSERVE` verb. They are not a new core
verb or endpoint. A host validates a bounded `session_checkpoint` v1 envelope,
then submits it as `application/json`; `REFLECT` materializes one agent-owned,
low-confidence claim with `claim_type=checkpoint` and
`claim_role=checkpoint`. The original envelope remains the L0 evidence.

## Envelope

Required fields:

| Field | Meaning |
|---|---|
| `kind` | `session_checkpoint` |
| `version` | `1` |
| `operation_id` | Stable Smartware operation identity carried through to `OBSERVE` |
| `checkpoint_id` | Deterministic checkpoint identity |
| `session_id` | Host session identity |
| `scope` | Required authorization and later-recall boundary |
| `trigger` | `post_turn`, `pre_compaction`, `shutdown`, or `manual` |
| `generation` | Non-negative retry-stable checkpoint generation |
| `summary` | Selective state required to resume work |
| `decisions` | Bounded decisions that constrain later work |
| `open_loops` | Bounded unresolved work or questions |
| `source_digest` | `sha256:<hex>` digest of the source state summarized by the host |

`checkpoint_id` is:

```text
checkpoint_ + sha256(session_id + NUL + trigger + NUL + generation)
```

The host should use `checkpoint_id` as `source_id` and pass `operation_id` to
`OBSERVE`. Retrying the same operation identity and payload returns the prior
result. Reusing it with a different payload is a conflict.

## Bounds

- complete serialized envelope: 16,384 characters;
- `summary`: 4,000 characters;
- at most 20 decisions and 20 open loops;
- each decision or open loop: 1,000 characters; and
- session and scope identifiers: 256 characters.

The model-visible host tool should ask for the minimum state another agent
needs to resume: decisions, constraints, verified progress, and open loops.
It should exclude transcript narration, repeated facts already in durable
memory, secrets, and speculative conclusions presented as fact.

## Lifecycle and scope

Checkpoint durability must exist and be tested before a host removes or marks
unwired session-end summarization. The embedded Smartware `sessionEnd` path now
reports `durability=not_configured` when an `auto` or `durable_summary` policy
has no summarizer callback; it no longer reports a fictitious zero persisted
claim count.

The envelope scope must equal the observation scope. Normal grant and
server-anchored-session scope checks still apply before the L0 write. Later
recall therefore sees the checkpoint only through the same scope boundary.

## Epistemic behavior

Automatic reflection does not promote a checkpoint to user truth. The L1
projection is agent-authored, agent-owned, low-confidence inference with full
observation provenance. Dream may use recent checkpoint claim identifiers to
produce an orientation-card source manifest, but does not synthesize or admit
new canonical assertions from it.
