# 0124. Workspace KV keeps one logical identity outside the records database

- **Status:** Accepted
- **Date:** 2026-07-12
- **Amended by:** [ADR-0134](0134-application-data-generations-own-immutable-workspace-namespaces.md) (KV declaration and identity are frozen inside one application data generation); [ADR-0139](0139-portable-workspaces-are-schema-directed-folders-applied-as-forward-mutations.md) (portable workspace folders encode declared KV separately as `kv.json`)
- **Relates:** [ADR-0093](0093-kv-metadata-belongs-to-the-workspace-kv-namespace.md) (reaffirmed), [ADR-0119](0119-complete-metadata-replicas-sync-through-schema-blind-server-ordered-mutations.md), [ADR-0120](0120-persisted-fields-are-atomic-cells-and-collaborative-bodies-are-yjs-documents.md), [ADR-0123](0123-bounded-metadata-uses-record-authority-merge-sensitive-state-uses-lazy-child-documents.md)

## Context

The SQLite record branch initially compiled declared KV keys into a reserved
record table, so a handful of preferences inherited row creation, snapshots,
imports, schema epochs, quarantine, and server ordering. Moving KV back to an
eager `YKeyValueLww` document removed that machinery, but the first API exposed
`rootDocumentIncarnation` so applications could rotate the whole preference
plane. Ordinary preference evolution does not need that second version axis:
missing or invalid values already read as defaults, and a semantic change can
use a new key.

## Decision

Declared `workspace.kv` is a bounded synchronized preference plane in one eager
`YKeyValueLww` document, separate from the SQLite record database. It keeps one
logical identity across ordinary application schema changes. The runtime derives
the internal identity `<workspaceId>.kv`; applications do not declare a KV
incarnation, epoch, or migration.

Only declared keys are admitted. Missing or invalid values read as fresh
defaults without overwriting the stored bytes. A semantic change that cannot
honestly interpret the old value uses a new dot-namespaced key. Obsolete keys may
remain physically stored, so the cumulative lifetime namespace and encoded
values must remain bounded. Yjs garbage collection stays enabled, and this
document contains synchronized KV only.

The logical identity is stable, not an operational promise that one physical
Y.Doc can survive every incident. A storage-format, encryption, corruption, or
recovery cutover may use an opaque runtime-owned generation and fence stale
storage. That mechanism never appears in the workspace definition.

Workspace KV synchronizes within the connection's principal partition. Device-
local or privacy-sensitive values use device storage. A product may explicitly
compose a local override above both stores, but `workspace.kv` never hides that
precedence or accepts a `{ sync: false }` mode.

## Consequences

- The record protocol has no KV rows, operations, snapshots, imports,
  quarantine, epoch participation, worker messages, or null-as-clear special
  case.
- Workspace definitions lose `rootDocumentIncarnation` and its validation,
  generation selection, and cross-generation behavior.
- `<workspaceId>.kv` names a narrow capability instead of creating a generic
  `.root` metadata drawer.
- Frequent overwrites remain compact with Yjs GC, but encoded state still grows
  with live values, cumulative keys, and causal ranges from historical client
  IDs. Persistence providers still own update-log compaction.
- `workspace.kv.reset()` removes declared overrides under ordinary sync
  semantics; it is not a history fence against an offline client.
- LWW uses trusted client timestamps, so this plane is for low-stakes
  preferences, not secrets, permissions, or security policy.
- A value that must change atomically with a record belongs in the record model.

## Considered alternatives

- **Keep KV in the record database.** Rejected because preferences do not need
  record lifecycle, snapshots, imports, epochs, or server ordering.
- **Expose an app-authored root incarnation.** Rejected because it turns a
  one-time legacy-root cutover into a permanent API and lets an ordinary schema
  edit reset every preference.
- **Use `<workspaceId>.root`.** Rejected because `root` describes topology and
  invites unrelated eager state; `kv` names the invariant that earns the
  document.
- **Put synchronized and device-local KV behind one API.** Rejected because
  every read would hide precedence, hydration, observation, and reset policy.
- **Migrate preference values in place.** Rejected because validate-or-default
  reads plus new semantic keys preserve the bounded preference contract without
  a generic migration engine.
