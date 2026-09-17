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
  `instance` principal. Durable keys use `principals/<principalId>/...`.
  Billing is hosted-only and lives in `apps/api/worker/billing/`.
- **Account**: one resolved principal inside one deployment. Credentials may
  rotate, but deployment identity plus `principalId` is the stable identity of
  the person's synchronized Epicenter.
- **Epicenter**: one person's logical body of application data. Each application
  is one document holding its own tables and settings, and applications bind
  one data definition over it; the definition id is the one lifecycle scope
  beneath it (ADR-0229, ADR-0255).
- **The Ark**: the public home of an Epicenter. It makes selected authored work
  publicly inhabitable as living pages whose text, audio, and video are
  alternate expressions of the same idea (ADR-0291).
- **Replica**: one complete local or server copy of an Epicenter. A native
  installation, browser origin, OS profile, or server actor may impose its own
  physical replica, but that adapter boundary is not a product data owner.
- **Epicenter store**: the storage backing one replica: the durable ledger a
  crash cannot reconstruct, which is the update log, with the outbox and the
  cursor read off it. One IndexedDB object store in the browser, with no worker
  and no OPFS (ADR-0238, ADR-0241).
- **Generation**: one whole database, created once by importing a folder and
  never mutated in place (ADR-0293). It is an exact ADDRESS: the number is in
  the local record's name, in the authority's Durable Object name, and in the
  page's URL, which is what retired the document identity stamp (ADR-0292).
  `openDatabase` takes one and never discovers one. SQL is not stored here: it is a
  follower an application composes, and no application composed one, so the
  package no longer ships it (ADR-0269).
- **Sync attachment**: the permanent binding from a local replica to one
  principal. First sign-in adds synchronization to the existing replica;
  signing out pauses it, and another principal requires a fresh replica or
  explicit destructive clearing.
- **Epicenter Home**: an application beside the other typed surfaces, not a shell
  above them (ADR-0209, amended by ADR-0226). It owns the launchable list,
  assistant sessions, commands and approvals. The applications are the crafted
  views over their own data, the OS is the launcher and switcher, and closing
  Home leaves them running.
- **Host**: the Bun process that serves an application's bundle and brokers
  credentials for it. It owns no application data and constructs no database
  (ADR-0226), so every build opens its own store and there is no platform seam
  where one build reaches somewhere else.
- **Third-party installed apps**: refused for now (ADR-0227). The admission
  model ADR-0186 through ADR-0211 built, and the app catalog vocabulary that
  went with it, waits for a second party to build one. The Epicenter-authored
  applications are served directly.
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
  over the inference seam. _Store sync_ carries one application's whole
  document through its authority as opaque bytes, over one socket, and covers
  nodes and rows alike; there is no separate document plane and no awareness or
  presence. _Invoke_ (the agent's hands) is local to the host that owns the tool process, unless a future product
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

- **Store**: one application's replica. One `Y.Doc` held in memory, its
  durable ledgers behind a persistence controller, and a synchronous surface
  over both. Opening one is the only asynchronous operation an application
  has.
- **Library**: one application's data in one destination, named Local,
  Personal, or Shared (ADR-0375). Local is this machine, Personal is one signed-in
  person's server data, Shared is one self-hosted deployment's common data.
- **App hub** (unbuilt, ADR-0392): what one `open(account)` returns: `device`,
  an optional `account`, plus `signal`, `ready`, and `close`. `device` is always
  present; `account` is present when a person is signed in. The framework supplies
  libraries and safe storage; applications choose library views and write
  destinations without a mandatory picker or copy feature. Each store sits
  under the scope that owns it. A page owns one auth generation, and an account
  change ends it. Today three openers each return one library instead.
- **Device scope** (unbuilt, ADR-0392): `app.device`, everything true of this
  application's device storage or browser profile. The same store implementation with no
  authority, plus `sqlite`, `secrets`, `connections`, and `recording`, which
  exist nowhere else. Its tables hold the library a person reads as Local. Local data and device
  preferences survive account changes; they are not account-private.
  Reopening replaces the handle, not the Local data. Blob storage is app-local
  and independent of these row libraries.
- **Account scope** (unbuilt, ADR-0392): `app.account`, everything true of the
  signed-in person on one server, present only while signed in. It holds
  `identity`, the `personal` store, the optional `shared` store, and
  `connection`, that server's inference gateway. It ends with the auth
  generation.
- **Blob reference** (ADR-0393): a local BlobId or remote URL stored as an
  ordinary row value. A row can reference several blobs and several rows can
  reference one blob. Row deletion does not delete bytes. There is no owning
  attachment field or automatic byte transfer.
- **Saved capture** (ADR-0366): Stop publishes completed audio into the app-local
  blob store and returns its key. The workflow then creates its recording row
  in the destination retained before capture. Failed row creation leaves the
  blob available. Unfinished capture may be lost on reload or termination.
- **Cross-library copy** (optional application workflow, ADR-0399): an app
  composes reads and ordinary destination creation. New rows get new IDs.
  Copying blob references does not upload bytes or transfer remote ownership.
  Sign-in does not move Local data.
- **Materialization** (ADR-0394): readable row Markdown, settings, and checkout
  metadata. Blob keys and URLs remain references; Pull copies no audio and
  downloads no remote objects. Local rows remain Local.
- **Saved folder** (ADR-0394): a copy or ZIP of the materialization as it stands,
  including unpushed edits. It contains no blob payloads or exact-state recovery
  guarantee. Server backup retention and a dedicated restore UI are deferred.
- **Content recovery** (ADR-0395): Pull a current working copy, preserve its
  manifest, bring selected old content into its files, and preview ordinary
  Push. Deleted rows return as newly admitted rows. File deletion permanently
  deletes the row; an application's Trash field is a normal frontmatter value.
- **Data definition**: one application's inert, pure JSON declaration of its
  durable data, created with `defineData` and read with `parseData` (ADR-0255).
  It is release-local: a newer release ships a newer declaration over the same
  durable data. Definitions have no defaults; initialization and recovery are
  application decisions.
- **Opened data**: the synchronous typed surface (`tables`, `kv`, `documents`,
  `store`, and `transact`) an opened store holds over one data definition.
  Born with the store; nothing rebinds a live store.
- **Database document**: the one Yjs document a database is (ADR-0295),
  persisted under the log name `app`. Its top-level roots are the bare named
  root `kv` and one `tables:<name>` root per declared table (ADR-0257). A row is
  nested under its table, and a row's node is nested under the row.
  There is no second document and no address that reaches one.
- **Table root**: the `tables:<name>` root holding one table's rows. Every
  top-level root says what kind of thing it is, so a table genuinely named `kv`
  lands at `tables:kv` and cannot reach the settings root.
- **Row**: a nested `Y.Type` held as an attribute on its table root. Holding it
  is what existing means, and there is no second fact that can disagree. Its id
  is minted and never reused.
- **Field**: one attribute on a row type. It holds either a **value** or a
  **node**, and that is the only division worth naming (ADR-0309). A value is
  replaced whole on write, so two devices writing one converge on a winner. A
  node is edited in place, so two devices editing one both keep every
  keystroke. Two devices editing different fields both keep their edit either
  way.
  <!-- vocab-check: ignore-next-line (the glossary entry that retires them) -->
  The retired names for these two are `scalar` and `prose`. Both described the shape instead of the behaviour: a `tags` array is a value though it is not scalar, and a node holds whatever its table's codec says, which is often not prose.
- **Whole-value replacement**: an array or object field is one value, so a
  concurrent write replaces all of it and one addition is lost (ADR-0228). This
  is chosen, not missing. A collection several devices append to concurrently
  wants to be a table.
- **Content node**: the one nested `Y.Type` every row holds, at the reserved
  key `content` (ADR-0299). Read it off the row: `table.get(id).content` is
  synchronous and hands back the live node; there is nothing to open and
  nothing to dispose. **Minted in the transaction that mints its row and never
  again**: a nested type is addressed by the struct that created it, so lazy
  minting on two devices would lose a subtree. A row holds exactly one, because
  one file has one region below the fence. Epicenter never reads inside one;
  the table's declared codec is the only thing that turns one into text.
- **Content codec**: the `content: { encode, decode }` every table declares
  (ADR-0299). `encode` takes the node and returns the text below the fence;
  `decode` takes that text and returns a fresh node. The platform owns the
  file, writing the values as frontmatter under their own field names, so no
  row shape ever reaches a codec author. There is no default: a node carries a
  sequence and attributes at once, so rendering one as text round-trips a keyed
  log into one literal string that prints identically. `plainText()` is a codec
  a table opts into.
- **Deletion**: removing the row's attribute from its table root. The whole
  subtree goes with it, the content node included, so there is one removal in one
  document and no second address to retire. No tombstone and no revive path
  (ADR-0219).
- **Nonconforming row**: a row this release's declaration cannot read. A view, not
  damage. `rows` and `nonconforming` are separate reads, and each failure carries
  its `address`, machine-readable `issues`, the `conforming` survivors, and the
  unmodified `raw`.
- **Healing**: repairing a nonconforming row with an ordinary `update`, because
  a patch validates only the values it supplies. Prevention is not on the table:
  a declaration is release-local and rows arrive from newer releases, so nothing this
  release ships stops a future one retyping a field.
- **Unknown field**: a field this release's declaration does not declare. Ignored on
  read and preserved on write, which is what makes a mixed-version fleet safe.
- **`kv`**: the bare named root holding one application's settings, as a single
  value with `get`, `update` and `subscribe`. It is `kv`, not `!kv`, and there is
  no top-level `tables` container; its subscriber takes no ids because kv is one
  value.
- **SQL projection**: a composed follower, never a store verb (ADR-0241). It
  rebuilds at the next read after a change, from the held table rather than the
  document (ADR-0307, ADR-0311), so it never serves rows the document has moved
  past. The package shipped one and no application ever
  composed it; it was deleted, and inspecting data outside the app is reading
  the export (ADR-0268, ADR-0269).
- **`subscribe`**: a table's change notification, carrying the row ids a commit
  touched and firing after every `onCommitted` listener has run (ADR-0221,
  ADR-0241). Not a query and not a diff.
- **Pressure**: structs the engine holds over rows the declaration can see. The one
  number worth watching, because a deleted row leaves a small permanent cost that
  only a rebuild reclaims.
- **Store authority**: one Durable Object per principal, application, and
  generation, named `principals/<id>/data/<dataId>/generations/<generation>`
  (ADR-0292, ADR-0298). It appends opaque bytes and reads nothing about their
  meaning.
- **`dial`**: the one thing a host supplies to the transport, a function that
  makes a socket. The library owns the cursor, attach and detach, reconnect, and
  the unacknowledged-submission watchdog (ADR-0222).
- **Blob**: immutable bytes with their own identity and lifetime. Local objects
  belong to the app on this device and use extension-bearing BlobIds (ADR-0349).
  Explicit remote uploads create independent account-owned objects and return
  URLs (ADR-0372). Neither row synchronization nor row deletion transfers or
  deletes bytes.
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
  messages as rows (ADR-0047). It replaced the older doc-observing _answerer_,
  which ADR-0047 removed.
- **Working-copy materialization**: Markdown documents, settings, and a checkout
  manifest. Pull writes app data to the folder; Push applies approved folder
  edits against the saved baseline. Blob IDs and URLs remain references: neither
  operation copies, fetches, or deletes blob bytes (ADR-0394, ADR-0395).
- **`attach*` vs `create*`**: `attach*` are side-effectful primitives that register
  listeners at call time; `create*` are pure construction.

## App composition

- **Application factory**: the one function that opens the application's data,
  and returns a ready handle, as `packages/app/src/client-owned-data.ts` does
  behind `epicenter.open()`. There is no readiness promise beside it: opening
  is the only asynchronous thing, so wanting a separate `whenReady` means a
  half-open handle.
- **Data session**: what `epicenter` owns once a definition and an account are
  passed. Construction is inert; `open` acquires the document, the Web Lock,
  the persistence connection, the sync socket, and the flush-on-hide listener,
  and `close` releases all five. `open()` is synchronous and answers a
  `DataSession` whose `opened` settles once; nothing on the store it resolves
  can end the session (ADR-0350).
- **Ready-application shape**: a boot node reads auth reactively and keys one
  session component on the principal; that component opens, renders `{#await
  session.opened}`, and closes on unmount. The shell it mounts calls `fromData`
  once and passes the result down through typed context. Library modules stay
  inert, which `scripts/check-boot-purity.ts` enforces.
- **`#platform/*`**: the build-time platform DI seam for multi-platform (Tauri) apps.
- **`session`**: the singleton holding the signed-in Epicenter lifecycle.
- **Device settings vs synced settings**: per-device settings (global shortcuts,
  the microphone, the inference selection) versus synced settings (in-app
  shortcuts). The asymmetry is deliberate (ADR-0007): machine-world settings face
  per-device collisions and OS keys. Device settings live in Whispering's
  `deviceConfig` today and belong in `device.kv` (unbuilt, ADR-0392). The
  machine's endpoint catalog is `app.device.connections` and the server's
  gateway is `app.account.connection` (unbuilt, ADR-0396).
- **Vault**: the designated, not-yet-built home for the one encryption that
  survives ADR-0004: an explicitly encrypted store for the values a person
  brings that name no durable local state, such as a provider API key. The key
  source is server-derived, not a passphrase (ADR-0074), and accounts and
  third-party OAuth grants are outside its scope: those belong to the app whose
  directory they name (ADR-0202). Its primitives were removed with the
  encryption layer, and `@epicenter/encryption` itself is now deleted; a secrets
  path rebuilds from scratch. Distinct from the Matter vault (a folder of
  Markdown).
