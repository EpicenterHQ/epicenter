# 0135. New builds ask before initializing a new data generation

- **Status:** Accepted
- **Date:** 2026-07-13
- **Amended by:** [ADR-0136](0136-applications-declare-immutable-data-versions.md)
- **Relates:** [ADR-0134](0134-application-data-generations-own-immutable-workspace-namespaces.md), [ADR-0088](0088-sign-in-is-an-enhancement-never-a-door.md), [ADR-0132](0132-an-obsolete-replica-exports-one-read-only-recovery-checkpoint.md)

## Context

A stable application URL must not silently open an empty new generation while
the user expects their existing data. Persisting a selected-generation flag
would create a second representation of state already carried by durable
generation namespaces. Inferring from row counts is also incorrect because an
initialized workspace may intentionally contain no records while KV,
documents, or blobs still exist.

Local absence cannot prove that another device did not synchronize an older
generation. A server-side current-generation registry would solve that lookup
by teaching the server application release semantics. The simpler answer is to
ask before the newest build initializes local storage whenever a predecessor is
possible.

## Decision

Generation discovery belongs to the build being opened, not to a standalone
generation-neutral shell. The build compiles the append-only generation lock,
probes its own namespace without creating files, database tables, authorities,
KV documents, child documents, or blob stores, and uses earlier lock entries to
know that a predecessor may exist. It does not import a predecessor's schema.

For data generation N, boot follows one state machine:

1. If N has a complete local root-database identity matching its lock entry,
   open N. Older generations remain reachable only through an explicit previous
   versions surface.
2. If N is absent and the lock has no predecessors, initialize N and open it.
3. If N is absent and the lock has any predecessor, ask before creating or
   opening N. The prompt may identify locally initialized predecessors, but it
   does not claim that locally absent predecessors have no synchronized data.
4. Continuing with a predecessor opens its versioned application route when
   that build is available. Starting the current version opens an already
   synchronized N authority if one exists or initializes an empty N otherwise.
   No choice is persisted, so the prompt returns until N has a complete local
   identity.
5. A namespace whose root file exists without a complete valid identity is not
   initialized. Boot refuses to overwrite it and offers an explicit recovery or
   deletion path.

Database initialization writes the complete identity in the same final
transaction as the root schema. File existence alone and user-row counts never
mean initialized. An intentionally empty but completely identified database is
initialized.

The initial product prompt offers **Start current version** and **Continue with
previous version** where a predecessor build is available. An application may
offer its existing export surface. Version one adds no generic export reader,
Copy button, importer, or cross-plane transaction.

Cross-generation copy may be added only by an application with one concrete
breaking release. It reads one source snapshot, writes only into an empty and
not-yet-finalized target, leaves the source unchanged, and explains that later
source edits do not appear in the target. It never imports into an existing
target, repeats, merges, translates pending mutations, or creates lineage.
Removing old local or synchronized data is a separate explicit destructive
operation after the user has inspected the new generation.

Starting a newer generation does not make an older one read-only. Devices may
continue using and synchronizing the older generation independently. A
cross-generation write fence would recreate the distributed cutover lifecycle
this model refuses.

Web deployments may retain same-origin historical builds, but runnable old code
is not a permanent data-sovereignty promise: any old same-origin script can
reach newer origin storage, and security may require withdrawing it. An
application may retire an old build only after it provides an honest inspection
or export path for every durable plane it owns. Generation data and lock entries
are never removed merely because a new generation was published.

## Consequences

- There is no selected-generation preference, migrated flag, neutral shell,
  generation manifest service, or server-side application-generation registry.
- A first-time user may see an extra choice after a breaking release because
  the build refuses to infer that no older remote data exists. That inconvenience
  buys a generation-blind server and prevents silent empty initialization.
- Initial generation selection is one-way by durable local state: once N is
  initialized, its build opens it directly. Explicitly visiting an older route
  does not change the default.
- Browser generations use same-origin routes so OPFS and authentication remain
  available. Subdomains do not define storage identity.
- Historical build availability is best-effort and environment-specific.
  Durable inspection and export are stronger promises than indefinite code
  execution.
- Copy remains app-owned product work. The platform does not acquire a seed
  type, migration runner, candidate database, reveal transaction, rollback,
  blob sharing, or garbage collection.

## Considered alternatives

- **Persist the selected generation.** Rejected: the newest completely
  initialized local namespace already determines the normal default, while an
  explicit old route handles exceptional access.
- **Infer use from nonempty records.** Rejected: empty workspaces and durable
  non-record planes are valid.
- **Add a neutral loader and fetched generation manifest.** Rejected: the
  current build already owns boot, and a separate artifact would need its own
  deployment and cross-platform lifecycle solely to choose another artifact.
- **Probe the server for predecessor generations.** Rejected initially: asking
  before first local initialization is more inconvenient but keeps the server
  unaware of application release history and avoids another discovery route.
- **Ship automatic Copy in the first implementation.** Rejected: no application
  has yet proved retry-safe copying across records, KV, child documents, and
  blobs.
- **Freeze the previous generation after cutover.** Rejected: offline devices
  would require a distributed retirement fence and recovery protocol.
