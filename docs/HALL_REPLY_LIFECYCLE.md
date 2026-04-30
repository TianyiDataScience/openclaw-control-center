# Hall Reply Lifecycle

This document defines the **single source of truth** for hall replies, typing drafts, and the durable message store. Architecture overview lives in [HALL_ARCHITECTURE.md](./HALL_ARCHITECTURE.md); this file scopes the rules that prevent reply / typing / handoff regressions.

If a future change violates this document, it is very likely to reintroduce one of the regressions we already saw:

- a reply appears and then disappears
- typing lingers after a reply lands
- visible `@someone` changes execution routing
- left list / right detail / bottom console disagree about the current task state

> **Note**: An earlier version of this doc described a `discussion` / `execution` / `review` / `blocked` stage machine and `discussionCycle` participant tracking. Both were removed in Phase A (2026-04-17) when hall switched to the autonomous group-chat model. The reply / typing / state-source rules below survive the transition unchanged — they are about **layer separation**, not about the deleted state machine.

## Goal

Hall must satisfy all three:

- agents follow the operator's latest instruction
- replies feel natural without breaking task flow
- task-card state stays consistent with persisted messages

That only works if we keep a hard separation between:

- **system-controlled flow state** (task card)
- **agent-generated content** (messages)
- **UI-only transient typing state** (SSE drafts)

## Single Source Of Truth

Only these layers are allowed to own these pieces of state:

| State | Owner | Notes |
| --- | --- | --- |
| `status`, `executionLock`, `currentExecutionItem` | task card | Activity is derived from these (see `resolveHallActivityLabel`); never derive from visible text. |
| `currentOwnerParticipantId` | task card | Never derive from visible `@mention`. |
| `plannedExecutionOrder`, `plannedExecutionItems` | task card | The only authority for planned routing. |
| `originalAssignerParticipantId` | task card | Set on the first operator post; agents are prompted to `@`-report back to this id. |
| `autoRoundsByAgent` | task card | Per-(card, agent) auto-round counter; reset on each operator post. |
| `humanReviewedAt` / `lastAgentActivityAt` | task card | Drives the `needsHumanReview` 10-minute idle window. |
| persisted thread history | hall messages store + `chat.jsonl` blackboard | Authoritative visible history. |
| typing / streaming content before persistence | hall SSE draft events | UI-only transient state. |

## What The System Controls

The system controls:

- task-card state mutations (status / executionLock / currentExecutionItem / planned execution / autoRoundsByAgent / originalAssigner / human-review markers)
- routing decisions: `@mention` resolution, target filtering by the policy chain, auto-chain depth, observer dispatch
- handoff metadata (structured handoff packets attached to messages)
- whether a reply is persisted (post-dispatch policy chain — A4 `OBSERVE_SILENT` is dropped silently)

The system must **not** let these content-layer signals control routing:

- visible `@monkey` (the routing signal is the parsed mention list, not the literal text)
- natural-language "next step"
- visible "handoff to X" (handoff is structured payload, not text)

Those can inform display, but they cannot override structured task state.

## What The Agent Controls

The agent controls:

- how the reply is phrased
- the actual deliverable content
- whether the explanation is brief or longer
- which other agents to `@`-mention next (parsed by the orchestrator into auto-chain targets, then filtered by the policy chain)
- whether to opt out of an observer turn by replying `OBSERVE_SILENT`

The agent does **not** control:

- whether the task moves status (operator / system controls status)
- who owns the next step (structured handoff, not visible text)
- whether the policy chain allows a particular auto-chain target

## Reply Lifecycle

```
┌────────────────────────────────────────────────────────────────────┐
│ 1. enqueue                                                         │
│    enqueueAndDispatch(args, dispatch_closure)                      │
│    ├─ append enqueue line to inbox/{agent}.jsonl                   │
│    └─ wake the (card, agent) worker; debounce window starts        │
│                                                                    │
│ 2. worker batch fire (after 750ms quiet)                           │
│    ├─ pre-dispatch policy chain on the per-target gate             │
│    │  └─ deny shortcuts; A2-deny triggers a system message         │
│    ├─ dispatchHallRuntimeTurn → real openclaw agent run            │
│    │  ├─ first turn: full setup prompt                             │
│    │  └─ subsequent turn: trigger-only minimal prompt              │
│    ├─ stream draft_start / draft_delta to hall SSE                 │
│    └─ runtime returns visible content + structured payload         │
│                                                                    │
│ 3. post-dispatch                                                   │
│    ├─ post-dispatch policy chain (A4 OBSERVE_SILENT → drop)        │
│    ├─ persist HallMessage to message store + chat.jsonl blackboard │
│    └─ emit draft_complete + new HallMessage to SSE                 │
│                                                                    │
│ 4. auto-chain (if reply has @mentions)                             │
│    ├─ chain candidate filter (chain-filter policy chain)           │
│    └─ each allowed target → step 1 with chainDepth + 1             │
│                                                                    │
│ 5. wake-mention initiator (if step 4 ran)                          │
│    └─ after all chained replies persist, dispatch the initiator    │
│       once more so it can review/follow up                         │
└────────────────────────────────────────────────────────────────────┘
```

If the agent is `main` (default observer) and was not the primary target of the operator post, an observer turn is appended after step 4 with a special prompt (`[mode: observer]`). It either contributes something useful or replies `OBSERVE_SILENT` and is suppressed by A4.

Multi-trigger merge: if the (card, agent) worker has more than one pending enqueue when the debounce window closes, all triggers go through one dispatch and the prompt is rendered with `[在短时间内你被多次 @ (N 条 trigger 合并)，请在一条回复里照顾到全部：]` so the agent answers all in a single reply. See [HALL_ARCHITECTURE.md § 信箱](./HALL_ARCHITECTURE.md#2-信箱mailbox--scheduler-p3b-1--p3b-2).

## Draft Rules

Drafts are the most fragile part of hall. These rules are non-negotiable.

1. A speaker may not have multiple active real drafts for the same reply.
2. A `draft_complete` without a persisted `messageId` is a **settled transient** state:
   - keep the visible content briefly
   - do not count it as typing
   - replace it when reload brings back the persisted message
3. A persisted message from author `X` at or after the draft time must suppress any lingering typing for `X`.
4. UI typing is never allowed to outlive a persisted message for the same author.

## Structured State vs Visible Content

When structured state and visible content disagree, structured state wins. Specifically:

- routing decisions are made from the parsed mention list, not the visible text
- handoff is a structured payload (`StructuredHandoffPacket`), not a sentence
- task-card status / executionLock are the only authoritative activity signal — never derive from "this looks like a handoff sentence"
- the `needsHumanReview` indicator is derived from `humanReviewedAt` / `lastAgentActivityAt`, not from any text the agent wrote

## States That Must Never Be Duplicated

These are the states we must not maintain in more than one control path.

### Never duplicate `current owner`

Allowed owner source: `taskCard.currentOwnerParticipantId`

Not allowed:

- infer from visible `@mention`
- infer from visible handoff sentence
- infer from the last author

### Never duplicate `current execution item`

Allowed source: `taskCard.currentExecutionItem`

Not allowed:

- infer from visible "next step"
- infer from the newest artifact

### Never duplicate typing truth

Allowed source: active hall SSE drafts.

Not allowed:

- separate hidden booleans in the UI
- independent per-author typing timers as flow state

### Never duplicate auto-round counters

Allowed source: `taskCard.autoRoundsByAgent`.

Not allowed:

- separate scheduler-level dispatch counters
- inferred counts from message history

(P3-C-1 and the policy chain made this a hard layer: `incrementAutoRoundCounter` is the only allowed write path, and the counter is read by `enforceAutoRoundLimit` from the persisted task card, not from any other surface.)

## Known Failure Modes

If any of these appear again, check the matching rule first.

### Reply appears, then disappears, then typing remains

Almost always means one of:

- duplicate draft lifecycle (rule 1 of Draft Rules)
- persisted message never landed (storage write failed silently — check `operation-audit.log`)
- settled draft still counted as typing (rule 2 of Draft Rules)

### Agent visibly hands off, but task card stays in old state

Almost always means: visible content was allowed to mutate task-card state. Routing must come from structured handoff, not text.

### Wrong next owner after a visible `@someone`

Almost always means: visible content was allowed to mutate routing. The orchestrator's mention parser is the only authoritative source.

### New thread starts with old topic memory

Almost always means: shared OpenClaw session key was reused across different task threads. Each `(taskCard, agent)` should resolve to its own `sessionKey` (linked via `linkRuntimeSessionKeyToTaskCard`).

### Auto-round counter desync

Almost always means: someone wrote `autoRoundsByAgent` without going through `incrementAutoRoundCounter`, or the counter check was done on a stale `taskCard` snapshot. The orchestrator carefully reflects post-increment counters into the local `taskCard` even when `updateHallTaskCard` fails — see the `dispatchHallAgentReply` per-target gate.

## Modification Checklist

Before changing hall reply logic, verify all of this:

1. Which layer owns the state I am touching?
2. Am I creating a second source of truth?
3. Am I letting visible text control routing?
4. Am I opening more than one real draft for one reply?
5. If a reply persists, what clears typing?
6. If a draft completes before persistence, what keeps the reply visible?
7. Which browser smoke proves this did not regress?
8. If I'm adding routing logic, does it belong in the policy chain (`hall-policies.ts`) or is it a one-off?

## Mandatory Regression Coverage

Any change touching hall replies must keep these green:

- multi-mention routing (operator @-mentions multiple agents in one message → all dispatch in parallel; debounce merges concurrent ones)
- visible `@mention` does not reroute execution (handoff is structured, not text)
- explicit user tasking beats default role behavior
- long visible deliverables do not get truncated away
- new task threads do not inherit old hall thread memory
- auto-round counter caps repeat dispatch at 6 per round
- `OBSERVE_SILENT` replies are dropped post-dispatch (not persisted, not chained)

## Short Version

Hall stays stable only if we keep this split:

- **task card owns flow** (status / executionLock / counters / human-review markers)
- **messages own history** (durable, persisted, blackboard mirrors)
- **drafts own transient typing** (SSE only, never persistent)
- **agents own content** (text and `@`-mentions; routing parses them but doesn't trust visible state)
- **policy chain owns routing decisions** (allow / force-allow / deny — see [HALL_ARCHITECTURE.md § 策略链](./HALL_ARCHITECTURE.md#3-策略链policy-chain-p3c-1--p3c-2))

Everything bad we saw came from violating one of those boundaries.
