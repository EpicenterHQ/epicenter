# Context: shared vocabulary

The words Epicenter uses for its own concepts, so humans and agents name the same
thing the same way. Keep entries to one or two lines. When a design pass coins or
sharpens a term, update it here in the same change. For the decisions behind these
shapes, see `docs/adr/`.

## Platform and topology

- **Deployment**: one reachable Epicenter installation, hosted or self-hosted,
  with a canonical base URL and its own auth, storage, sync, and billing policy.
- **Connection**: the authenticated transport a client uses to reach one
  deployment. It carries credentials, cookies, or bearer behavior, but is not the
  data identity.
- **Principal**: the authenticated identity Epicenter uses as the partition key
  (ADR-0092). Cloud resolves many principals from Better Auth users; a
  self-hosted instance resolves every valid operator bearer to the literal
  `instance` principal. Durable namespaces use `principals/<principalId>/...`.
  Billing is hosted-only and lives in `apps/api/worker/billing/`.
- **Account**: one resolved principal inside one deployment. Credentials may
  rotate, but deployment identity plus `principalId` is the stable identity of
  the person's synchronized Epicenter.
- **Epicenter**: one person's logical body of rows and values. Every row owns
  scalar fields, zero or one persisted Yjs document, and zero or one immutable
  blob. Applications bind typed Lenses to it; no workspace or database
  lifecycle exists beneath it.
- **Replica**: one complete local or server copy of an Epicenter. A native
  installation, browser origin, OS profile, or server actor may impose its own
  physical replica, but that adapter boundary is not a product data owner.
- **Epicenter store**: one runtime-private storage family backing a replica. Its
  physical relations and format version are implementation details, not an
  application SQL contract. Home may expose the stable logical inspection model
  through the store owner.
- **Sync attachment**: the permanent binding from a local replica to one
  principal. First sign-in adds synchronization to the existing replica;
  signing out pauses it, and another principal requires a fresh replica or
  explicit destructive clearing.
- **Epicenter Home**: the trusted shell above typed application surfaces. It owns
  navigation, assistant sessions, commands, approvals, and human and agent
  relational inspection; durable data such as conversations lives in ordinary
  tables and values.
- **Home inspection session**: the store-owner-mediated read-only SQL capability
  supported only by Epicenter Home. One store owner exposes at most one active
  friendly Lens interpretation; ordinary application Lens binding creates no
  SQL state.
- **Trusted app catalog**: the validated static SPAs Epicenter serves from one
  origin and grants one fixed app-window authority. Bundled output supplies the
  default catalog; admitted output may replace a member by app ID.
- **Static-artifact admission**: the one boundary an app folder crosses to
  become a catalog member. Epicenter validates and copies inert built files; it
  never installs dependencies, runs an app's build system, or reads application
  source. Provenance (publisher URL, self-hosted builder, local developer build,
  offline media) changes nothing about the authority the served app receives,
  and source sitting beside an artifact is an unverified claim, not evidence
  (ADR-0179).
- **Full app trust**: an admitted app runs *as* Epicenter. Its authority is the
  shared origin and session, the OS-granted device access the webview already
  holds, and the one app-window native command surface. Only the third is
  enumerated in a capability file, and it is not a sandbox.
- **Account authority**: the one server replica for everything an authenticated
  principal stores. Its address derives from the principal alone. It orders
  whole-Epicenter scalar synchronization and hosts separate lazy row-document
  connections.
- **Row-document connection**: one authenticated Yjs 14 WebSocket for one
  currently open `(namespace key, table key, row ID)`. Its structured route address
  is lifecycle identity, not a secret; it is separate from the whole-Epicenter
  scalar facts and submissions protocol.
- **Row liveness**: the owner-local fact that a row address is currently
  live. Deletion replaces scalar state with a permanent compact tombstone and
  removes document and blob state, so an offline replica cannot recreate that
  lifetime. Liveness is a lifecycle invariant, not a per-row ACL.
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
  other directly, then forgets. Blind to content in principle. _Fused with the anchor
  today_: the hosted relay is one Cloudflare Durable Object that also holds and reads
  your plaintext (ADR-0035); separating the relay role from the anchor (ADR-0035) would
  let a blind relay route to an anchor you hold.
- **Store**: the anchor's app-blind sibling for big binaries (audio, images),
  `put` / `get` / `has` by reference; the doc carries the reference, never the bytes
  (ADR-0035). Any S3-compatible endpoint (versitygw for dev, Garage for self-host).
- **Trusted relay**: the server reads Epicenter plaintext. Zero-knowledge was
  evaluated and rejected; the encryption layer was removed (ADR-0004).
- **Node roles**: four distinct roles, separable even when one machine plays
  several (ADR-0049): _client_ runs the agent loop and binds the others;
  _inference server_ turns a prompt into tokens; _daemon_ holds data and runs
  dispatched tools but never infers; _relay/anchor_ is content-blind coordination
  and never infers.
- **Inference server**: the only node role that infers (ADR-0049). One stateless
  turn per request: given a prompt plus a tool catalog it streams tokens, returns
  the model's tool calls, and stops, leaving the client loop to execute them
  (ADR-0047). It sees the prompt and tools as accepted egress to the model
  (ADR-0033), so it is _not_ content-blind, unlike the relay, but it owns no loop,
  tool, or transcript. The wire is OpenAI-compatible (ADR-0050), so the box is
  swappable by base URL: Epicenter's metered gateway (house key, billed; it never
  accepts a provider key), a self-hosted gateway (your key or a local model), or
  any third-party OpenAI-compatible endpoint. A BYOK key is handed to a custom
  inference server (self-hosted or local), never to the Epicenter gateway or a
  daemon (ADR-0054).
- **Deployable vs library**: one library, `packages/server`, consumed by two
  deployables: `apps/api` (hosted personal cloud) and `apps/self-host` (the
  community single-partition instance reference, not Epicenter-operated; ADR-0075).
- **Cross-device planes**: cross-device work splits by responsibility. _Inference_ (the
  chat brain) streams tokens from an OpenAI-compatible endpoint (ADR-0050),
  over the inference seam. _Scalar sync_ carries rows and values through the
  Epicenter authority. _Document sync_ publishes durable Yjs updates
  automatically and uses row-document connections only for lazy acquisition and
  low-latency edits; it carries no awareness or presence. _Invoke_ (the agent's
  hands) is local to the host that owns the tool process, unless a future product
  re-earns a direct URL-addressed box surface.
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

## Data API

- **Namespace key**: the durable reverse-domain coordinate at the front of a
  row or value address, such as `so.epicenter.whispering`. It structures
  addresses only and never creates a lifecycle, ownership, or sync scope.
- **Local data key**: the exact property name under a Lens's `tables` or
  `values`, such as `recordings` or `language`. Renaming it addresses different
  data; it is not an ergonomic alias.
- **Row address**: `(namespace key, table key, row ID)`, distinguished from a
  value address by its address kind. A row-owned document reuses this address.
- **Value address**: `(namespace key, value key)`, distinguished from a row
  address by its address kind.
- **Lens**: a pure JSON, partial, release-local interpretation of exactly one
  namespace. Lenses may overlap and are never authoritative schemas, owners, or
  lifecycle boundaries.
- **Table definition**: the pure JSON value under one Lens table property. It
  validates schema-opaque row fields but does not create storage, migrate, heal,
  rewrite, or grant access.
- **Value definition**: the pure JSON value under one Lens value property for
  one typed singleton with `get`, `set`, and `unset`.
- **Bound lens**: the synchronous borrowed typed view returned when a Lens binds
  to an open Epicenter. It creates no storage and owns no disposal.
- **Raw inspection relations**: the reserved lossless `_epicenter_rows` and
  `_epicenter_values` SQL relations exposed only inside a Home inspection
  session. They preserve unknown and nonconforming data without freezing the
  private SQLite layout.
- **Friendly Lens views**: the explicit-column read-only TEMP views created for
  the one Lens selected by an active Home inspection session. They are
  connection-local interpretations, not application APIs, stored rows, indexes,
  or namespace lifecycle.
- **Row**: one identified application value in a table. It is the public
  lifecycle aggregate over scalar fields, zero or one persisted Yjs document,
  and zero or one immutable blob. Its globally unique runtime-minted ID is never
  reused. Deletion installs a compact tombstone and removes document and blob
  state.
- **Row tombstone**: terminal scalar state proving that a structured row address
  was deleted. It carries no application payload and remains so an indefinitely
  offline or restored replica cannot recreate that row lifetime. Value unset is
  nonterminal latest state and may be replaced by a later set.
- **Field key**: the exact permanent member name under a table definition's
  `fields` object. The Lens supplies it even when an optional row has no value
  for that key. A field schema has no separate `id` or `key`; there is no
  fallback key, alias, automatic rename, or storage default. The containing
  definition supplies identity just as the runtime supplies a row's ID.
- **Field**: one `field.*` schema for a present JSON value. Table fields are
  required by default; a table's `optional` key array names fields that may be
  absent. Missing and `null` remain distinct.
- **Row-owned document**: the zero-or-one persisted collaborative Yjs state
  owned by a row. It has no public id, authority, or lifecycle independent from
  the row. Live stores use private bounded baseline-plus-tail chains; logical
  artifacts expose one nullable compact update on the row.
- **Record**: not a platform lifecycle noun in the canonical data model.
  Use row for the durable application aggregate, fields for JSON values, and
  document for the row-owned CRDT state. Historical docs and transitional code
  may still use record while they migrate.
- **Conforming row**: a canonical row that satisfies the opened release's table
  definition. Reads return typed rows while reporting nonconforming stored data
  without hiding or silently repairing canonical state.
- **Optional field unset**: patching an optional field with `undefined` removes
  that key. Canonical JSON never stores `undefined`; `null` remains an ordinary
  value when its field accepts null.
- **Table traversal**: one complete classified typed application read in stable
  row ID order. `entries()` consumes it lazily through private runtime batches;
  `scan()` consumes the same traversal to completion and groups conforming rows
  from nonconforming diagnostics. Applications receive no public pages,
  cursors, filters, ordering options, or SQL.
- **Row document handle**: the revocable handle returned by a lazy row document
  open. It exposes application roots, local provider durability, and document
  connection status. Releasing the final handle may unload live Yjs state but
  never deletes persisted or synchronized content.
- **Document publication receipt**: post-commit authority proof for one exact
  frozen document update, bound to its authority lifetime, row address, protocol
  version, and payload digest. State vectors are transfer hints, never receipts.
- **Scalar vocabulary, landed and proposed**: the four terms below did not land
  together. Scalar fact and scalar intent are the current production protocol:
  `@epicenter/data/protocol` ships them, and the authority stores facts in the
  split row and value relations ADR-0178 defines. Facts feed and scalar
  submission are still the destination Proposed ADR-0163 selects and nothing
  serves them. Production carries both over ADR-0141's combined exchange at
  `POST /api/sync/v1`, which keeps a public receipt and cursor that ADR-0163
  would remove. So the semantics moved and the transport did not.
- **Scalar fact**: the authority's current state at one structured row or value
  address. A fact carries one global authority sequence and explicit presence.
  Present rows carry fields, present values carry content, absent rows are
  terminal tombstones for the authority lifetime, and absent values are
  reversible unsets.
- **Scalar intent**: one compacted desired transition at a structured address,
  named by a verb because it is a command and the action is its whole content.
  Typed row create and update both lower to one `patch`: whether a row is new is
  something the authority knows and the replica only believes, so `patch` folds
  over the live row or over an empty object and is refused outright once the
  address holds a tombstone. `delete` ends a row. Values take `set` and `unset`.
- **Facts feed**: the whole-Epicenter HTTP read of current authority facts after
  one `afterSequence`. Each installed bounded prefix advances that one durable
  watermark. `hasMore` only reports whether the same read snapshot contained
  another qualifying fact.
- **Scalar submission**: one replica's numbered, bounded, exactly retryable set
  of intents. The current authority fact for every touched address is its
  settlement proof. There is no public request digest, receipt, global
  settlement watermark, or transaction meaning.
- **Row blob**: the zero-or-one write-once immutable byte stream owned by one
  live row. The row address is its sole identity; SHA-256 proves the accepted
  bytes and makes publication idempotent. Application fields or documents give
  the bytes meaning. Large media remains a separate transfer plane from scalar
  state and the row's bounded interactive CRDT document.
- **Data runtime**: one Epicenter replica composes typed table/value lenses and
  lazy Yjs 14 row documents over one private store.
- **Worker**: running behavior that observes Epicenter state and writes results
  back. Workers may be local (every node runs them) or agent-bound (one
  configured agent answers). A conversation is answered by the client agent loop
  in the open tab, for every agent (ADR-0047).
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
  messages as records (ADR-0047). It replaces the older doc-observing _answerer_
  (a daemon that wrote the reply into the doc), which ADR-0047 removed. Two
  implementations exist, chosen by transcript reach (ADR-0048): a transcript that
  syncs across a person's peers uses `createConversation` (`@epicenter/agent`),
  which persists finished messages as rows; a deliberately device-local
  transcript uses TanStack `createChat` (tab-manager, IndexedDB).
- **Materializer**: a local, addressless worker that projects Epicenter data
  into another store (markdown, sqlite). Matter is the one surviving user.
- **`attach*` vs `create*`**: `attach*` are side-effectful primitives that register
  listeners at call time; `create*` are pure construction.

## App composition

- **`create<App>`**: the isomorphic doc factory for an app.
- **`open<App>Browser` / `open<App>Extension` / tauri**: environment factories.
- **`#platform/*`**: the build-time platform DI seam for multi-platform (Tauri) apps.
- **`session`**: the singleton holding the signed-in Epicenter lifecycle.
- **deviceConfig vs synced values**: per-device settings (global shortcuts,
  machine collisions) versus synced settings (local shortcuts). The asymmetry is
  deliberate.
- **Vault**: the designated, not-yet-built home for the one encryption that
  survives ADR-0004: an explicitly encrypted store for secrets only (blind
  relay, Argon2-derived key). Its primitives were removed with the encryption
  layer, and `@epicenter/encryption` itself is now deleted; a secrets path
  rebuilds from scratch. Distinct from the Matter vault (a folder of Markdown).
