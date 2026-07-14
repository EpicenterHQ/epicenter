# Context: shared vocabulary

The words Epicenter uses for its own concepts, so humans and agents name the same
thing the same way. Keep entries to one or two lines. When a design pass coins or
sharpens a term, update it here in the same change. For the decisions behind these
shapes, see `docs/adr/`.

## Platform and topology

- **Workspace**: one version-qualified identity and access-policy boundary.
  It owns synchronized KV, child documents, app-owned blobs, and one active
  records epoch.
- **Application data version**: one immutable durable application contract
  spanning records, KV, child-document identities and formats, and app-owned
  blobs. Any durable contract change publishes a new data version.
- **Data version lock**: the committed append-only list of an application's
  generated workspace IDs, records hashes, and durable-plane identity tokens.
  It carries no compatibility or migration graph.
- **Workspace ID**: the framework-generated `<appId>-vN` namespace for one
  application data version. Applications author only `appId` and a positive
  `dataVersion`.
- **Data-version-aware boot**: the current build inspects its own local root
  identity without creating storage. If it is absent and predecessors exist,
  the build asks before starting its data version or navigating to a previous one.
- **Room**: one server-side synchronization address. Yjs rooms store document
  updates; the records authority stores logical rows, mutations, and
  snapshots. Cloudflare may colocate several such logical stores in one Durable
  Object SQLite database without making their physical file the sync contract.
- **Star**: the one runnable program that holds your data, composing anchor,
  store, sync, and identity/auth into a deployment (ADR-0069). The star is the
  unit of self-host and the entire privacy question: Epicenter runs it (hosted)
  or you run it (self-host). Distinct from a **service you call** (inference,
  blob URLs): a service is addressed by `{baseUrl, token?}`, sees only the one
  payload you hand it, and is never part of the star's topology. "Single-user /
  sovereign" is a preset over the star's credential source and principal
  resolver, not a mode (ADR-0070, amended by ADR-0092).
- **Anchor**: the always-on node that holds synchronized state so a sleeping
  device can catch up. Who runs the anchor is the whole privacy question (ADR-0068):
  user-run gives topology privacy, Epicenter-run is trusted plaintext. Privacy moves
  by relocating the anchor, never by a setting in the app.
- **Relay**: moves bytes between a person's devices when they cannot reach each
  other directly, then forgets. Blind to content in principle. *Fused with the anchor
  today*: the hosted relay is one Cloudflare Durable Object that also holds and reads
  your plaintext (ADR-0035); separating the relay role from the anchor (ADR-0035) would
  let a blind relay route to an anchor you hold.
- **Store**: the anchor's app-blind sibling for big binaries (audio, images),
  `put` / `get` / `has` by reference; the doc carries the reference, never the bytes
  (ADR-0035). Any S3-compatible endpoint (versitygw for dev, Garage for self-host).
- **Trusted relay**: the server reads workspace plaintext. Zero-knowledge was
  evaluated and rejected; the encryption layer was removed (ADR-0004).
- **Node roles**: four distinct roles, separable even when one machine plays
  several (ADR-0049): *client* runs the agent loop and binds the others;
  *inference server* turns a prompt into tokens; *daemon* holds data and runs
  dispatched tools but never infers; *relay/anchor* is content-blind coordination
  and never infers.
- **Inference server**: the only node role that infers (ADR-0049). One stateless
  turn per request: given a prompt plus a tool catalog it streams tokens, returns
  the model's tool calls, and stops, leaving the client loop to execute them
  (ADR-0047). It sees the prompt and tools as accepted egress to the model
  (ADR-0033), so it is *not* content-blind, unlike the relay, but it owns no loop,
  tool, or transcript. The wire is OpenAI-compatible (ADR-0050), so the box is
  swappable by base URL: Epicenter's metered gateway (house key, billed; it never
  accepts a provider key), a self-hosted gateway (your key or a local model), or
  any third-party OpenAI-compatible endpoint. A BYOK key is handed to a custom
  inference server (self-hosted or local), never to the Epicenter gateway or a
  daemon (ADR-0054).
- **Deployable vs library**: one library, `packages/server`, consumed by two
  deployables: `apps/api` (hosted personal cloud) and `apps/self-host` (the
  community single-partition instance reference, not Epicenter-operated; ADR-0075).
- **Principal**: the authenticated identity Epicenter uses as the partition key
  (ADR-0092). Cloud resolves many principals from Better Auth users; a
  self-hosted instance resolves every valid operator bearer to the literal
  `instance` principal. Durable namespaces use `principals/<principalId>/...`.
  Billing is hosted-only and lives in `apps/api/worker/billing/`.
- **Cross-device planes**: cross-device work splits by responsibility. *Inference* (the
  chat brain) streams tokens from an OpenAI-compatible endpoint (ADR-0050),
  over the inference seam. *Sync* (convergent state) carries document history
  over the relay, and server-owned presence reports which workspace peers are
  online. *Invoke* (the agent's hands) is local to the host that owns the tool
  process, unless a future product re-earns a direct URL-addressed box surface.
- **Infisical project**: the owner and access-control boundary. Each secret-using
  runnable surface owns its own `.infisical.json`: `apps/api` and `ops` point
  at Epicenter's hosted/operator project, and personal local apps use ignored
  app-local configs that point at the operator's personal project. The ignored
  configs are per-person bring-your-own provider setup; the committed configs
  are shared Epicenter infrastructure. A single-provider local app may instead
  cache its BYO client credentials to a machine-tier 0600 file after first
  connect (Local Mail's <data-dir>/provider.json), so it reads no per-worktree
  Infisical config on the run path; Infisical then only ever populates the
  environment for that first connect.
- **Infisical environment**: a value-stakes tier inside a project, not an
  owner. In the Epicenter project, `dev` holds substitute values that can hurt
  nothing (the local `wrangler dev` bindings) and `prod` holds hosted
  production/operator credentials. In a personal local-app project, `prod`
  holds the real provider credentials for the person running the tool. The path
  groups by app or surface (`/api`, `/ci`, `/ops`, `/apps/<app>`). The provider
  target rides in the qualified secret name (ADR-0108), never in the
  environment. The monorepo root has no Infisical config, so local apps cannot
  silently inherit Epicenter's hosted/operator project.

## Workspace API

- **Cell**: one named atomic value in a record. An update replaces the complete
  cell value; values that need structural or character-level merging belong in
  a child document instead.
- **Record**: one identified row in a typed table, consisting of a stable row ID
  and named atomic cells. Records have explicit create, update, and delete
  lifecycles.
- **Record table**: one named, typed collection of records. The table defines
  record fields and may declare separately stored child documents addressed
  through each record.
- **Records database**: storage terminology for the complete queryable
  collection of record tables in one records epoch. Every synchronized device
  materializes it in local SQLite; the authority stores logical records, not a
  device's SQLite file.
- **Records epoch**: the authority-minted identity of one continuous records
  history inside one application data version. Restore or repair may mint a
  new epoch, but a schema change always publishes a new data version.
- **Sequence**: the authority-assigned position of an accepted mutation inside
  one records epoch. A sequence has no meaning without its epoch.
- **Records schema hash**: the canonical identity of synchronized record tables,
  fields, and every portable constraint that changes accepted values or their
  interpretation. Workspace identity, KV, child documents, local indexes,
  physical storage, and the records epoch do not enter it. The hash is frozen
  inside one application data version; applications author neither the hash
  nor the epoch.
- **Records descriptor**: canonical, hash-bound JSON that explains the record
  tables, fields, and code-independent constraints. Every authority epoch and
  durable SQLite materialization stores it beside the hash. It contains no
  executable actions, permissions, KV, child-document contents, or replica
  transport state.
- **Document format**: one Epicenter-owned collaborative Yjs representation. A
  format capability carries a canonical descriptor, a derived format hash, and
  the function that attaches its typed handle to an open Y.Doc. Document format
  identity is independent of the records schema hash.
- **Records epoch fence**: the authority transactionally admits work only when
  its records epoch is current. An old cursor or write is rejected before it can
  enter the new history.
- **Logical snapshot**: live table, row, field, and value state without SQLite
  pages, indexes, actor identity, cursors, outboxes, or deleted history.
- **`defineTable` / `defineKv`**: builders for the records tables and synchronized
  preferences frozen into one application data version. Adding or renaming a
  table, field, KV key, or child-document declaration requires a new data version.
  Every `define*` call snapshots caller-owned inputs into a framework-owned
  immutable definition.
- **Recovery checkpoint**: a read-only export from an epoch-fenced replica. It
  carries the obsolete epoch, canonical descriptor and hash, complete local
  logical rows, and pending logical mutations. It contains no SQLite pages,
  indexes, cursors, or automatic replay instruction.
- **`satisfiesWorkspace`**: the bundle-conformance helper (renamed from the older
  `defineWorkspaceBundle`).
- **Actions and collaboration**: actions live on the workspace bundle;
  collaboration is sync and presence only.
- **`scan()`**: the single bulk table read. Returns three buckets, conforming,
  nonconforming, and newer-writer, plus point probes. The valid-only read family
  (`getAllValid`, `getAllInvalid`, `getAll`, `conformance`, `filter`) was deleted.
- **`_v`**: the legacy Yjs-table row version tuple. The SQLite records path does
  not use it; one application data version has one frozen records schema.
- **Conformance**: whether a stored row matches the current schema. Nonconforming
  rows surface in `scan()`, never silently dropped.
- **Child document**: a separate, lazy Y.Doc owned by one row and reached through
  `ws.tables.X.docs.name.open(rowId)`. The workspace derives its address from the
  version-qualified workspace ID, table, a collision-resistant digest of the
  full row ID, document name, and document format hash; the format capability
  attaches the typed content handle after the runtime opens the doc.
- **Worker**: running behavior that observes workspace state and writes results
  back. Workers may be local (every node runs them) or agent-bound (one
  configured agent answers). A conversation is answered by the client agent loop
  in the open tab, for every agent (ADR-0047); the daemon contributes data and
  side effects as dispatched actions (tools), never by running the loop.
- **Agent**: the durable address a row or conversation binds to (an immutable
  id). An agent names who should answer; the peer that answers as it is the
  client tab or a daemon, set by the agent's **trust location** (ADR-0030/0043).
- **Trust location**: where an agent's data and tools live, and therefore where
  its side effects run (ADR-0030, ADR-0047). The reasoning loop always runs in
  the client, which drives an inference server (ADR-0049); what varies is the
  agent's capability. A **capability-free** agent (Vocab) has no tools. A
  **local-data** agent (Local Books) keeps its data and action handlers on the
  user's own always-on daemon, which the client loop reaches by dispatching
  actions; data leaves the daemon only as a tool result. The relay is
  content-blind; the inference server is a stateless turn that sees the prompt as
  accepted egress (not content-blind). Trust is per-agent, not global.
- **Conversation loop**: the client-side loop that answers every conversation,
  streams the live turn into a snapshot the UI renders, and persists finished
  messages as records (ADR-0047). It replaces the older doc-observing *answerer*
  (a daemon that wrote the reply into the doc), which ADR-0047 removed. Two
  implementations exist, chosen by transcript reach (ADR-0048): a transcript that
  syncs across a person's peers uses the workspace loop (`createConversation`,
  finished messages in a Yjs child doc); a deliberately device-local transcript
  uses TanStack `createChat` (tab-manager, IndexedDB).
- **Materializer**: a local, addressless worker that projects workspace data into
  another store (markdown, sqlite).
- **`attach*` vs `create*`**: `attach*` are side-effectful primitives that register
  listeners at call time; `create*` are pure construction.

## App composition

- **`create<App>`**: the isomorphic doc factory for an app.
- **`open<App>Browser` / `open<App>Extension` / tauri**: environment factories.
- **`#platform/*`**: the build-time platform DI seam for multi-platform (Tauri) apps.
- **`session`**: the singleton holding the signed-in workspace lifecycle.
- **deviceConfig vs workspace KV**: per-device settings (global shortcuts, machine
  collisions) versus synced settings (local shortcuts). The asymmetry is deliberate.
- **Vault**: the designated, not-yet-built home for the one encryption that
  survives ADR-0004: an explicitly encrypted, shared workspace for secrets only
  (blind relay, Argon2-derived key). Its primitives were removed with the
  encryption layer; it returns minimally if a secrets path is built. Distinct
  from the Matter vault (a folder of Markdown).

## CLI and watcher

- **Epicenter root**: a directory whose `epicenter.config.ts` declares one mount.
  Discovery walks up to the nearest one. One root, one watcher.
- **Watcher**: the long-lived foreground process started by `epicenter up`.
  It opens the root's mount, owns the lease, joins sync when signed in, and keeps
  materializers alive. It is not a callable action server. Internal code still
  uses `daemon` names (`DaemonMetadata`, `claimDaemonLease`) for this process.
- **Peer**: a device currently connected to the same workspace room. Presence is
  server-owned and surfaced by app UI or watcher logs, not a generic CLI query.
- **Watcher lifecycle commands**: `up`, `down`, `status`, and `logs`. They use
  metadata, pid liveness, logs, and OS signals. No Unix socket or daemon action
  client exists.
- **Library script**: a `bun ./script.ts` that reads materialized SQLite or
  Markdown directly. Generic off-process writes are deliberately absent; real
  write workflows should earn an app-specific command or in-process script.
