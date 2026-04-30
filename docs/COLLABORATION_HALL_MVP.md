# Collaboration Hall MVP

> Architecture overview lives in [HALL_ARCHITECTURE.md](./HALL_ARCHITECTURE.md). This file scopes the **product surface and protocol contracts** — what the hall looks like to operators, agents, and clients.

## Product shape

- `Collaboration` defaults to one shared hall, not one task room per task.
- Operators post requests in the hall.
- Agents reply using the current real roster names from `openclaw.json` / runtime roster discovery.
- Agent replies stream into the hall as SSE draft deltas before the final persisted message lands.
- When hall runtime dispatch is enabled, those draft deltas are backed by real `openclaw agent` runs and normalized session history, not only synthetic orchestrator text.
- When the runtime exposes live stdout, the hall now prefers that direct stream first and only falls back to session-history deltas when needed.
- Task rooms remain available as secondary detail and evidence threads.

## Core objects

- `CollaborationHall`: the shared group chat container.
- `HallTaskCard`: the task card anchored in the hall timeline. Lives across the whole task lifecycle; activity status is derived from `executionLock` + idle window, not from a stage enum.
- `HallMessage`: one message in the shared timeline. Persisted to the messages store and mirrored to the per-card blackboard `chat.jsonl`.
- `TaskRoom`: the linked detail/evidence thread behind a task card.

## Routing rules

- `@RealAgentName` routes only to the matching participant.
- `@all` broadcasts to the active hall participants.
- No mention on a new task routes to the planner-like / manager-like participant first.
- No mention on follow-up messages routes to the `main` agent (default responder).
- Multiple `@`-mentions in one message dispatch all targets in parallel; concurrent dispatches to the same target are merged by the inbox debounce window.

> The autonomous group-chat model replaced the legacy stage machine (`discussion` / `execution` / `review` / `blocked`). See [HALL_ARCHITECTURE.md](./HALL_ARCHITECTURE.md) for routing internals — message lifecycle, blackboard, mailbox + scheduler, policy chain, observer, auto-chain.

## Anti-loop guarantees

Routing safety is enforced by a small set of policies in `src/runtime/hall-policies.ts` that run as a chain before every dispatch:

- `enforceAutoRoundLimit` (A2) — a hard cap on dispatches to the same `(task card, agent)` pair within one operator round; on hit the card surfaces a system message and the chain stops.
- `enforceMaxAutoChainDepth` — caps auto-chain reply depth at 5.
- `detectClarifyingQuestion` — explicitly allows real reverse Q&A through, overriding A3 and back-ping budget when the trigger looks like a question.
- `dropResolvedTriggers` — drops auto-chain triggers whose content is already covered by the candidate's most recent reply (token-overlap heuristic).
- `enforceBackPingBudget` — at most 1 reverse ping per `(B → A)` pair per operator round.
- `excludeTriggerAuthor` (A3) — trigger author is excluded from the chain candidate list (final ping-pong guard).
- `observeSilentMarker` (A4) — `OBSERVE_SILENT` replies are dropped post-dispatch.

Full chain composition + ordering rationale: [HALL_ARCHITECTURE.md § 策略链](./HALL_ARCHITECTURE.md#3-策略链policy-chain-p3c-1--p3c-2).

## UI principles

- Hall timeline is the visual center.
- Task cards stay visible, but secondary to the active conversation.
- Draft agent replies should feel live, not poll-based, while still settling into durable stored messages.
- The operator should be able to answer three questions in under five seconds:
  - Who is speaking now?
  - Who owns execution now?
  - What needs human attention?

## Delivery model

- Hall clients subscribe to `/api/hall/events` with `EventSource`.
- Linked task-room clients subscribe to `/api/rooms/:roomId/events`.
- Generated agent replies emit `draft_start`, `draft_delta`, and `draft_complete` events.
- Hall message posts and assignment dispatch real `openclaw agent` runtime turns, polling the live session history and turning new assistant/tool output into draft deltas.
- Auto-chain follows `@`-mentions in the agent's reply (depth limit 5; see policy chain above).
- Final messages still persist through the normal hall / room stores so refresh, replay, and summaries stay durable.

## Blackboard files

Each task card has a working directory (`runtime/hall-workspaces/{cardId}/`) with:

- `.hall/chat.jsonl` — append-only group-chat transcript; the durable source of truth.
- `task_plan.md` / `findings.md` / `progress.md` — shared markdown owned by the agents themselves; each agent writes its own block wrapped with `<!-- agent: X, ts: Y -->`, append-only by convention.
- `.hall/inbox/{agent}.jsonl` — per-target enqueue/consume audit log.
- `.hall/deliveries.jsonl` — per-dispatch outcome audit log.

Agents access these via plain shell tools (`cat`, `grep`, `jq`) on dispatch — the orchestrator no longer curates context into prompts. See [HALL_ARCHITECTURE.md § 黑板](./HALL_ARCHITECTURE.md#1-黑板blackboard-p3a--p3a-2) for the prompt simplification rationale.

## Reply / typing / state contracts

The hard rules that prevent reply-typing-handoff regressions are kept in a separate document: see [HALL_REPLY_LIFECYCLE.md](./HALL_REPLY_LIFECYCLE.md).
