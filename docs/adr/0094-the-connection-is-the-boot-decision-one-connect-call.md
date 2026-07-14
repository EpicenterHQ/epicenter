# 0094. The connection is the boot decision: one connect call

- **Status:** Accepted
- **Date:** 2026-07-02
- **Amended by:** [ADR-0141](0141-workspace-authority-is-selected-once-and-owns-one-local-database.md) (SQLite apps project boot auth into one workspace authority instead of a nullable Yjs connection)

## Context

ADR-0088 settled that sign-in is an enhancement: every app boots into a
working local workspace and reads `auth.state` once. Its first spelling was a
pair of presets, `connectLocal(compose?)` and `connect(connection, compose?)`,
with every app writing the same ternary between them and a skill rule
mandating "pass the SAME compose callback to both presets." That rule was the
tell. The two presets shared one compose context type and one composition
order (child-doc openers, compose, infrastructure); they differed only in
which infrastructure wired after compose. Forcing the shared compose to be a
hoisted variable also cost TypeScript its contextual inference, so the four
apps that pass a compose hand-annotated its parameter four different ways: the
raw `ConnectedWorkspaceContext<...>` generics, an ad hoc `Pick<...>`, a
`Parameters<Parameters<...>[1]>[0]` extraction, and the throw-guarded
`projectSignedIn` spread beside each of them.

## Decision

`connect(connection: ConnectionConfig | null, compose?)` is the one browser
preset. The connection value IS the boot decision: credentials wire
principal-scoped storage plus the relay, `null` wires the bare local-first
infrastructure (guid-named IndexedDB, cross-tab channel, no relay). Both arms
return the same bundle shape, discriminated by `collaboration`. `connectLocal`
is deleted, not aliased.

The ADR-0088 policy itself ("signed out means local") is code once, not
transcribed per app: `toConnection(auth, nodeId)` in `@epicenter/svelte/auth`
projects the boot-time auth snapshot to `ConnectionConfig | null`, replacing
`projectSignedIn` and its signed-out throw (`null` is now a legal projection,
not an error). An app boots with
`model.connect(toConnection(auth, nodeId), compose?)`.

For the compose parameter, an inline arrow infers its type contextually; a
compose big enough to stay a named function annotates it with the exported
`ComposeContext<typeof myAppWorkspace>`, the one honest spelling.

## Consequences

The per-app boot ternary, the same-compose documentation rule, and all four
hand-written compose annotations are deleted; the boot line cannot be written
inconsistently because there is nothing left to vary. The return type is the
`LocalWorkspace | ConnectedWorkspace` union that every app already handled
(the runtime branch made it a union regardless); a caller that statically
knows it passed credentials narrows on `collaboration`, which one workspace
test does with a one-line guard. The `@epicenter/workspace` package stays
auth-agnostic: `toConnection` lives in the private Svelte package, and any
non-auth caller can still hand-build a `ConnectionConfig` or pass `null`.
Literal-argument overloads (`connect(null)` returning `LocalWorkspace`
exactly) were considered and refused as four extra signatures for one test
site; reintroduce them only if narrowing guards spread through product code.
