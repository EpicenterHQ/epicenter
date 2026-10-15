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
  (ADR-0092). Every deployment resolves principals from Better Auth users.
  Durable keys use `principals/<principalId>/...`.
  Billing is hosted-only and lives in `apps/api/worker/billing/`.
- **Account**: one resolved principal inside one deployment. Credentials may
  rotate, but deployment identity plus `principalId` is the stable identity of
  the person's synchronized Epicenter.
- **Epicenter**: one person's logical body of application data: their data
  folders, each a directory of files with Git history beside it.
- **The Ark**: the public home of an Epicenter. It makes selected authored work
  publicly inhabitable as living pages whose text, audio, and video are
  alternate expressions of the same idea (ADR-0291).
- **Replica**: one complete local or server copy of an Epicenter. A native
  installation, browser origin, OS profile, or server actor may impose its own
  physical replica, but that adapter boundary is not a product data owner.
- **Epicenter Home**: the window labelled `home`, shown to people as Settings
  since ADR-0537: an application beside the other typed surfaces, not a shell
  above them (ADR-0209, amended by ADR-0226). It owns assistant sessions,
  commands, approvals, and local model administration. The launchable list
  moved to the Folders window, which Epicenter opens to. The applications are
  the crafted views over their own data, the OS is the launcher and switcher,
  and closing either window leaves them running.
- **Host**: the Bun process that serves an application's bundle and brokers
  credentials for it. It owns no application data and constructs no database
  (ADR-0226), so every build opens its own folder and there is no platform seam
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
- **Deployable vs shared package**: one package, `packages/server`, consumed by one
  deployable, `apps/api`, on two runtimes: the hosted Cloudflare Worker and Bun
  with Postgres (`apps/api/server.ts`), which is the self-host path.
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

- **Data folder** (ADR-0517): a directory containing `epicenter.json`, which
  declares the `<table>/<stem>.md` directories and `kv.json` beside it. It may
  sit at any depth in any Git repository; apps open and sync only one at a
  repository root.
- **Owned attachment** (ADR-0456): zero or one `<id>.<extension>` sibling of
  `<table>/<id>.md`, created and deleted with its row; links do not acquire ownership.
- **Query projection** (ADR-0494): an in-memory SQLite database built from a
  data folder's current files for one query or session; nothing persists it.
- **Remote** (ADR-0532, ADR-0521): the folder's `remote.origin.url`, set by
  Connect. A sync fetches and pushes plain Git, with a token, to that server.
- **Sync** (ADR-0489): the one explicit action that saves, commits, fetches,
  combines, and pushes a folder. Nothing transfers on its own.

The Yjs store and its vocabulary (stores, store definitions, the store
authority, generations, and row nodes) were removed on 2026-10-14; read them in
Git history before that date.

- **Blob namespace** (ADR-0426): an app owns the blob namespace selected by its
  ID and storage owner. A BlobId identifies an object there; it does
  not include the namespace or account. Local paths retain `device/no-account`.
- **Blob reference** (ADR-0427, ADR-0428): a BlobId plus any placement scope not
  supplied by context. `copyFrom` preserves bytes and creates a fresh destination
  ID. A locator is not an access grant; a playback URL is temporary. Rows do not
  own byte lifetime, and row synchronization does not copy bytes.
- **Saved capture** (ADR-0366): Stop publishes completed audio into the app-local
  blob store and returns its key. The workflow then creates its recording row
  in the destination retained before capture. Failed row creation leaves the
  blob available. Unfinished capture may be lost on reload or termination.
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
- **`attach*` vs `create*`**: `attach*` are side-effectful primitives that register
  listeners at call time; `create*` are pure construction.

## App composition

- **Capability**: the operation surface a consumer borrows from its owner,
  such as a folder's `files`. Borrowing operations does not transfer readiness
  or shutdown ownership.
- **Device settings vs synced settings**: per-device settings (global shortcuts,
  microphone, inference selection) stay on the device; synced settings are the
  folder's `kv.json`. This follows the collision and OS ownership distinction in
  ADR-0007. Inference catalogs and gateway clients open independently of the
  folder.
- **Vault**: the designated, not-yet-built home for the one encryption that
  survives ADR-0004: an explicitly encrypted place for the values a person
  brings that name no durable local state, such as a provider API key. The key
  source is server-derived, not a passphrase (ADR-0074), and accounts and
  third-party OAuth grants are outside its scope: those belong to the app whose
  directory they name (ADR-0202). Its primitives were removed with the
  encryption layer, and `@epicenter/encryption` itself is now deleted; a secrets
  path rebuilds from scratch. Distinct from a Markdown notes vault (a folder
  of Markdown).
