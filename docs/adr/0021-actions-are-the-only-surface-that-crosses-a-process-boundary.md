# 0021. Actions are the only surface that crosses a process boundary

- **Status:** Accepted
- **Date:** 2026-06-16
- **Amended by:** [ADR-0112](0112-the-cli-watcher-is-not-a-callable-action-server.md) (deletes the callable CLI daemon) and [ADR-0166](0166-data-document-sync-and-agent-replace-workspace.md) (deletes the Workspace compose, mount, table, and KV surfaces while retaining explicit validated app and tool boundaries)

## 2026-07-06 amendment

ADR-0112 deletes the CLI daemon IPC surface. `connectDaemonActions`, `epicenter
run`, `epicenter list`, and the local daemon action socket are no longer active
surfaces. The surviving decision is narrower: actions remain the validated
in-process app/tool boundary for mutating workspace state; raw tables, KV, and
materialized projections still must not become generic off-process write APIs.

## Context

A workspace exposes three things: raw `tables`, raw `kv`, and `actions`. Several
consumers want to touch a workspace from outside the process that owns its Y.Doc:
CLI `run`, library scripts, the in-app AI chat, and remote mesh peers. The
question that kept recurring across the CLI-input and scripting design passes was
"what may each of them reach, and who decides." Left unstated, it invites a
different answer per surface (a CLI flag grammar here, a script table handle
there, an arbitrary-SQL action somewhere else), which is how a one-shape system
fractures into N almost-equivalent ways to do the same thing.

## Decision

The wire boundary is the action boundary. `tables` and `kv` are in-process only;
the only thing that crosses a process boundary is an action. An action is the
published, schema-guarded, serializable projection of in-process table/KV access:
it does not replace raw access, it is a layer over it (`shared/actions.ts:139`,
and an action handler gets `.tables`/`.kv` but no connection-bound `.open`,
`document/workspace.ts:129-162`).

This is structural, not policy. A script gets `connectDaemonActions`, a `Proxy`
whose every property becomes `client.run({ actionPath, input })`
(`client/daemon-actions.ts:62-72`); it has no `.tables` to reach, runs no
workspace code, and holds no Y.Doc (`client/connect-daemon-actions.ts:8`). The
browser, which owns its doc, gets full `tables`/`kv` directly off `connect()`
(`document/workspace.ts:271`); its `compose` callback returns only `actions`
because `compose` defines the served wire surface (`workspace.ts:289`; the daemon
`mount()` compose is the same rule, `workspace.ts:363,650`), not because it gates
the local developer.

Access scope is therefore a function of writer-identity: an in-process doc owner
(daemon, browser, action handler) sees full `tables` + `kv` + `actions`; everything
across the wire (script, CLI, AI, peer) sees actions and nothing else.

## Consequences

- The CLI needs no input sugar. Sugar (`--arg key=value`, generated `--flags`,
  nested key paths) is a lossy re-encoding of the JSON Schema the action already
  publishes; the JSON-native consumers (scripts, AI, future MCP) never touch a
  shell, so sugar would serve only hand-typing humans, whose need is
  discoverability (`epicenter list <action>`), not a second grammar. The CLI keeps
  one JSON lane, three sources (inline / `@file` / stdin).
- Coding agents default to scripts that call typed actions, because the typed
  object literal is the only compile-time-checked input modality in the system and
  is what agents are best at producing. The CLI is the human path and the
  granular-per-call-approval escape hatch (extends ADR-0009).
- A script's default read path is query actions (typed, consistent); the
  direct-file SQLite reader is the bulk/FTS escape hatch. Wrapping that reader in
  an arbitrary-SQL action is refused: it would serialize whole result sets back
  over the socket, defeating the only reason the direct reader exists, while still
  returning untyped rows.
- Every off-process write is forced through `invokeAction` schema validation plus
  the action's own invariants, so no external caller can write a malformed row or
  bypass business logic. Single-writer is preserved because no external caller
  holds a doc.
- The cost: an off-process caller cannot do an ad-hoc read or write the author
  never published as an action. That is the intended trade; the answer is to
  publish an action, not to hand out raw store access across the wire.

## Considered alternatives

- **A `defineWorkspace` "script" path exposing a read-only doc plus actions.**
  Rejected: it drags Y.Doc construction back into the script process,
  reintroducing replay cost and a second-writer risk that the separate
  `connectDaemonActions` (no doc, type-only) exists to avoid.
- **An arbitrary-SQL action (`sql_query({ sql })`) so scripts only ever call
  actions.** Rejected for local scripts: it makes the bulk-read path slower (full
  result-set serialization over the socket) and adds a broad SQL surface for no
  typing gain. Reconsider only for a remote peer reading another node's
  materialized data it cannot open as a file.
- **CLI flag sugar for ergonomics (the `gh --field` precedent).** Rejected: `gh`'s
  domain is untyped REST; Epicenter has a per-action schema, so the affordance
  `--field` smuggles in is better served by `list <action>` without coercion
  ambiguity. Purely additive later if user testing demands it.
