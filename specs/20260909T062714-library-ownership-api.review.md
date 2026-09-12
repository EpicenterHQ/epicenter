# Library vocabulary and ownership API review

Status: Draft

Review of [the handoff](20260909T062714-library-ownership-api.handoff.md), before production implementation. Recommendations below are proposals, not newly accepted product decisions or existing APIs.

Files inspected by the coordinator and independent reviewer follow. Some large files were inspected through targeted excerpts and symbol searches. This inventory precedes the analysis so the proposal can be checked against its evidence.

```text
.
|-- .agents/skills/
|   |-- design-review/SKILL.md
|   |-- greenfield-clean-breaks/SKILL.md
|   |-- post-implementation-review/SKILL.md
|   |-- specification-writing/SKILL.md
|   `-- writing-voice/SKILL.md
|-- specs/20260909T062714-library-ownership-api.handoff.md
|-- docs/adr/0375-library-ownership-is-local-personal-or-shared-within-one-deployment.md
|-- apps/
|   |-- api/worker/
|   |   |-- index.ts
|   |   `-- account/README.md
|   |-- epicenter/
|   |   |-- AGENTS.md
|   |   `-- src/
|   |       |-- desktop-auth-authority.ts
|   |       `-- ui/Settings.svelte
|   |-- honeycrisp/
|   |   |-- AGENTS.md
|   |   `-- src/lib/
|   |       |-- application.ts
|   |       |-- runtime.ts
|   |       `-- platform/
|   |           |-- auth.browser.ts
|   |           `-- auth.epicenter-host.ts
|   |-- self-host/
|   |   |-- AGENTS.md
|   |   |-- README.md
|   |   |-- server.ts
|   |   `-- worker/index.ts
|   |-- vocab/src/lib/application.ts
|   `-- whispering/src/lib/
|       |-- application.ts
|       `-- bootstrap.ts
`-- packages/
    |-- app/src/
    |   |-- index.ts
    |   `-- browser.ts
    |-- app-shell/src/boot-screens/
    |   |-- departure.ts
    |   |-- departure.test.ts
    |   |-- connection-screen-context.ts
    |   |-- cannot-open-screen.svelte
    |   |-- open-failure.ts
    |   `-- open-failure.test.ts
    |-- auth/src/
    |   |-- auth-contract.ts
    |   |-- create-session-auth.ts
    |   |-- desktop-broker-auth.ts
    |   |-- hosted-browser-redirect-auth.ts
    |   `-- instance-server.ts
    |-- blobs/src/
    |   |-- browser.ts
    |   `-- native.ts
    |-- data/src/
    |   |-- definition/addresses.ts
    |   `-- store/
    |       |-- browser.ts
    |       |-- browser.test.ts
    |       |-- handles.ts
    |       `-- store.ts
    |-- device/src/
    |   |-- library-claim.ts
    |   `-- owner.ts
    |-- principal/src/principal.ts
    |-- recorder/src/recording.ts
    `-- server/src/
        |-- principal.ts
        |-- auth/
        |   |-- create-auth.ts
        |   `-- session-handoff.ts
        |-- middleware/require-auth.ts
        |-- routes/
        |   |-- blobs.ts
        |   `-- session.ts
        `-- store-sync/
            |-- mount.ts
            |-- generations.ts
            `-- authority.ts
```

## Recommendation

Keep Local, Personal, and Shared as library names. Keep Account as the person signed in to one server. Rename `openAccount` to `openPersonal` and add `openShared`. Bind the chosen library once when constructing the App, and use that binding for every storage capability.

The product sentence is: each application opens one library, and a signed-in person can use their Personal library or their server's Shared library.

The handoff has the right product direction. It is not yet a complete execution specification: generation initialization, resource addressing, named-user admission, and runtime scope need concrete contracts first.

## Standard vocabulary

| Term | Meaning |
| --- | --- |
| Library | One application's data in a selected destination |
| Local | This installation's device-local application data, without server synchronization |
| Personal | This person's application data on one server, synchronized across their devices |
| Shared | One application's common data on one self-hosted server, writable by every admitted user |
| Account | One uninterrupted attachment to a signed-in person on one server |
| Server | The server the person connects to; Cloud or self-hosted |
| Principal | The authenticated actor, in developer-facing code |
| Replica | A device-held copy of a server library, in developer-facing code |

Use Local / Personal / Shared in library pickers and descriptions. Use Account in sign-in, profile, credential repair, and sign-out surfaces. Never label Shared as an account. Local does not need a fabricated account.

Local is a separate library, not the offline state of Personal or Shared. All three use local storage. In browser copy, describe Local as stored in this browser when that is the actual persistence boundary; "this device" must not imply that separate browser profiles share it.

Cloud offers Local and Personal. Self-hosting offers Local, Personal, and Shared. Shared means admitted users of that server, not anonymous access. Personal describes whose application library it is; it does not promise encryption against the server operator.

The phrase "library ownership" is useful shorthand, but Local describes placement while Personal and Shared describe access. Do not force these three choices into three kinds of authenticated principal.

## Public API and callers

These are proposed calls, each illustrating a separate document opening:

```ts
application.openLocal();
application.openPersonal(account);
application.openShared(account);
```

Keep the existing App readiness and close contract. The three verbs have one internal construction path. Do not expose both these verbs and a public `open(destination)` equivalent.

A single explicit-destination opener could encode the same valid states. The current callers do not pass reusable library objects around, so that extra public object has no demonstrated job. Three verbs directly express the product vocabulary and require an Account only for the two server libraries. They also provide no argument for another user's personal ID.

Honeycrisp and Vocab currently end their declaration with `.openAccount(account)`. Their Personal opening becomes `.openPersonal(account)`. Shared uses the same captured Account and `.openShared(account)`. Their signed-out boot currently opens no App, so making Local available there requires an explicit boot/UI change; a rename alone does not deliver the ADR's availability table.

Whispering's current opening choice is:

```ts
account === null
  ? application.openLocal()
  : application.openAccount(account);
```

The proposed boot path parses the selected library once and performs the corresponding call. It requires an Account for Personal and Shared. A missing or expired credential must not silently select Local. Whispering's current `authClient.method === 'recovery'` branch belongs to the unfinished auth migration and is not a target API to preserve.

Library switching reuses the existing departure boundary:

```ts
await departure.go(() => {
  // Navigate to the selected library in a fresh document.
  location.assign(nextLibraryUrl);
});
```

This is a proposed use of the existing `go` method; URL spelling is still to be designed. Parsing a URL selects a destination, never grants access or copies data.

## Ownership below the API

Current shape:

```text
AccountIdentity + Account transport
  -> local data address, SQLite address, blob address, locks
  -> server principal partition
```

Proposed shape:

```text
installation configuration -> one server and its identity namespace
session owner              -> one Account (the actor)
document bootstrap         -> one selected library
App construction           -> immutable library binding
                              |-- local replica address
                              |-- library-scoped sync and blobs
                              `-- recording, SQLite, locks, erasure scope
server request boundary    -> authenticated actor + authorized library
```

No package reorganization is needed to establish this decision. Keep the existing App, session, and departure owners. A small shared address contract earns its place across data, device, blobs, and recording; a public LibraryManager, credential wallet, or permissions framework does not.

The binding must distinguish three coordinates:

1. Actor: Alice on server A.
2. Remote library: app X's Personal(Alice) or Shared library on server A.
3. Local replica: Alice's device-held copy of that library.

Recommend including the actor in Shared's local cache address. Alice and Bob then synchronize to the same remote Shared library while retaining separate local caches and outboxes. Switching to Bob must not submit Alice's pending offline edits using Bob's credentials. Removing Alice's local copy must not erase Bob's cache. The cost is duplicate Shared caches when several people use the same browser profile. This is application isolation, not an OS security boundary against someone with access to that profile.

The logical local address includes app, server authority, actor, library choice, data definition, and generation where applicable. Local uses its existing separate address. Derive the relevant prefixes from one captured binding; locks, SQLite, blob storage, recording recovery, and generation erasure must agree.

The logical remote library includes `appId`, with `dataId` beneath it for stored definitions. Today the server addresses data by principal/dataId and blobs by principal/blobId; neither is a complete per-app library address. New Shared storage must be app-scoped, including its blobs.

Existing Personal Cloud keys must not be silently rewritten for symmetry. Preserve their bytes through an explicit physical-layout mapping until a separately designed data transition changes them. That mapping does not establish new per-app physical erasure or sandbox guarantees for historical account-wide blobs. The host still runs trusted apps; this proposal does not authorize hosting arbitrary users' executable code on the trusted origin.

Account transport remains actor-bound. Inference and Cloud billing continue to identify Alice when she uses Shared. Only library data traffic is destination-bound. Keep Local's existing no-account data composition; adding signed-in inference to Local is a separate capability decision.

## Server authorization

Authenticate the bearer first. Then resolve the requested library:

| Request | Server decision |
| --- | --- |
| Personal | Derive ownership from the authenticated actor; accept no alternate personal owner ID |
| Shared | Require current admission and a deployment offering Shared; resolve its app-scoped shared destination |
| Anonymous, unknown destination, or Cloud Shared | Refuse |

Store the authenticated principal and authorized library separately in request context. Preserve the principal for session identity, administration, diagnostics, and billing. Store synchronization, generation routes, upload tickets, blob reads, and blob deletes must use the same authorized library.

An immutable TypeScript binding prevents accidental mixing in callers. It cannot authorize a forged request. Desktop HTTP and WebSocket forwarding must preserve the destination through their own validated route handling while retaining the host's captured Account and keeping credentials out of windows.

Deployment admission is the only Shared membership rule. Do not add organizations, library membership tables, invitations, per-document ACLs, or a Shared user. Named-user self-hosting still needs real admission, session issuance, removal, and recovery. Reusing a sign-in UI does not implement those guarantees.

## Correctness blockers before execution

1. **Concurrent first opening can split Shared.** `discoverGeneration` in `packages/data/src/store/browser.ts:1240` lists generations and posts a new one after an empty result. `mount.ts` allocates for every import POST. Alice and Bob can both observe empty, receive different generations, and remain on different cache-first histories. The concurrency test at `browser.test.ts:478` covers one origin's Web Lock, not independent devices. Give the server's library/generation owner an atomic, retry-safe initial-generation selection. Keep explicit import as a distinct operation. Test crashes between reservation, stored bytes, and admission; a failed initializer must not publish a partial generation or create competing defaults.

2. **Session identity is still Cloud-specific.** `createSessionAuth` fixes `authorityId` to `epicenter-api` and attaches Cloud account-management links. Supplying a different URL without changing that contract aliases matching users across servers. Installation composition must supply a trusted authority namespace; arbitrary server metadata cannot claim Cloud's reserved bytes. Preserve official Cloud's existing identity. The current origin-derived instance identity is evidence for a simple isolated namespace; URL aliases or a server replacement are explicit configuration/data transitions, not automatic identity continuity.

3. **Storage resources must change together.** `AccountIdentity` currently drives data, device ownership, blob caches, locks, and recording recovery. Updating only the store can combine Shared rows with Personal attachments. A principal rename is insufficient. Keep identity as the actor and introduce the library/replica address where ownership actually differs.

4. **Revocation is bounded.** Existing server sockets receive 600 seconds of authorization. Blob GET tickets last 120 seconds and PUT tickets 300 seconds. New requests can reject a removed user while already issued capabilities remain usable for their established lifetime; an in-flight operation needs its own completion policy. Choose and test a removal contract before describing removal as immediate. Offline copies cannot be retracted.

5. **Bun lacks store synchronization.** `apps/self-host/server.ts` serves other API capabilities; the Worker mounts the store backend. Either implement Bun's backend or explicitly choose the Worker as the first complete named-user/Shared reference. Do not claim both deliver the new product after adding sessions alone.

6. **Old `instance` data needs a destination decision.** Do not make the first user its owner or reinterpret its principal bytes as Shared. Design an operator-initiated export/import selecting the target server and library, including referenced blobs and verification. Leave the source intact until a separately authorized retirement step.

Atomic first opening does not settle later shared rebuild/import policy. Existing replicas remain generation-specific. Before exposing a Shared rebuild action, specify how other members find the replacement and what happens to offline edits; do not silently merge separate generations or promise they converge.

## Selection and deletion

Recommend per-application-document library selection with one host-wide Account/server. Shared notes can then coexist with Personal recordings. Changing the notes library closes and navigates that document; sign-out or server replacement coordinates all affected windows. This recommendation remains a product choice, not a settled UI contract.

Keep the existing close-before-replacement behavior. A failed producer/storage close blocks replacement. A relaunch failure leaves the closed page in a recovery state rather than reopening the old App in place. Same-owner credential repair preserves Account attachment; unexpected retirement closes locally without selecting a replacement.

Use different operations and copy for:

| Operation | Meaning |
| --- | --- |
| Delete shared content | Any admitted user can remove content through the shared application |
| Remove local copy | Close producers and erase only the addressed device replica/cache |
| Remove user | Operator changes admission and revokes future access; Shared content remains |
| Delete account/deployment data | A separate administrative erasure workflow with its own guarantees |

Full read/write Shared access already includes deleting shared content. It does not imply a working physical whole-library purge endpoint. Hosted account deletion currently refuses destructive work, as documented in `apps/api/worker/account/README.md`; this review does not add an automated erasure promise.

## Simplification and deletion map

| Remove or replace after proof | Replacement guarantee |
| --- | --- |
| `openAccount` public name and examples | `openPersonal` names the actual destination; no compatibility alias |
| Account identity used as every storage owner | One immutable library binding supplies each resource's address |
| Fake Shared principal/account and shared credential switching | Alice stays the authenticated actor in both server libraries |
| Cloud identity/link policy inside generic session creation | Installation selects issuer identity; Cloud composition supplies Cloud links |
| Consumer branches asking whether session auth is Cloud | One session lifetime contract and concrete sign-in composition |
| Instance-token entry, expected-`instance` checks, alternate connection UI | Named-user admission/session path, once implemented and verified |
| Client empty-list startup creation | Server-owned atomic initial-generation selection |
| Proposed library manager, organization model, or owner-ID picker | Three opening verbs and the deployment's single admission rule |

The new complexity is necessary: named sessions, one library address contract, server destination authorization, and coordinated initial generation creation. Local caches gain a library coordinate. Self-host setup becomes more involved than handing out one bearer token. The product already chose independent people and Personal libraries, so the token-only provisioning promise cannot survive unchanged.

Keep Account retirement, departure sequencing, host credential brokerage, local producer locks, and explicit generation history. Those boundaries own real failures. Do not turn this work into a data-engine rewrite or split binaries merely to avoid a small startup configuration boundary.

## Ordered implementation plan

1. Resolve per-document selection, initial/default library UX, installation configuration/reconfiguration, and the first complete self-host runtime. Select a concrete admission/sign-in/recovery implementation without assuming Google, OIDC, or a particular database is mandatory.
2. Specify actor, library, and replica coordinates, including exact durable identity preservation and app/data scope. Define server destination validation, removal lifetimes, and library-switch failure behavior.
3. Prove server authorization and atomic initial generation creation with independent Alice/Bob clients. Include failed initialization recovery. Do this before migrating app callers.
4. Separate shared session lifetime from Cloud policy and implement named-user self-host admission. Preserve same-owner repair, local offline identity, retirement, and host brokerage. Keep billing in `apps/api/worker/billing`.
5. Bind libraries in App construction and thread the binding through sync, blobs, SQLite, recording, locks, and local removal. Preserve existing data bytes; write the explicit legacy import plan without running it.
6. Translate openers and application boot/selection together. Include Local boot in Honeycrisp and Vocab if the ADR availability table is the target. Reuse departure for library replacement and coordinate host-wide departure for account/server replacement.
7. Verify the new path, stop importing the obsolete token-selection/openAccount paths, and then delete them. Reconcile the older account-selection specs and draft decisions after this direction is accepted; do not delete unfinished work as though it had shipped.

Decisive evidence uses Alice and Bob on server A, then a server B with matching user IDs. Personal data stays separate; Shared converges within A; server B stays separate. Simultaneous empty-library opening must select one generation. Exercise document data and attachments, independent caches, offline reopening, removed users, credential repair, library changes, pending recordings, failed close, and failed relaunch. Assert that Alice's pending outbox never uploads as Bob. Attempt forged Personal owner selection, Cloud Shared, anonymous Shared, and altered app/library destinations through HTTP and WebSockets.

## Independent review and verification limits

The design-review skill's independent read-only GPT-6 reviewer reconstructed the proposal from the handoff and current code without an inherited conclusion. The coordinator accepts its recommendations for three verbs, separate actor/library/replica coordinates, app-scoped Shared storage, and server-atomic initialization. The coordinator checked the main findings against current source, including the concurrency test's local-lock limitation.

Per-window selection and the complete self-host runtime remain product choices. Existing Cloud physical layout changes, automated physical erasure, and later Shared rebuild behavior remain separate decisions. No production files were edited, tests run, or prototypes executed for this review. Existing passing lifetime tests cited by the handoff are historical evidence, not validation of this model. The dirty worktree was inspected without attributing its changes to an implementation baseline.

## Checkpoint 1 investigation: 2026-09-09

This section supersedes the earlier verification limits for checkpoint 1 only.
Production openers and storage remain unchanged. Runnable evidence lives in
`packages/server/evidence/library-ownership/` and the independent device runner
at `packages/data/evidence/library-ownership/device.ts`. These are test-only
proposals, not package exports or a second execution plan.

### Live caller map corrections

| Owner | Live path and consequence |
| --- | --- |
| Application construction | `packages/app/src/index.ts` captures Account, then passes it to blobs, `openAppData`, recording, secrets, and account AI. `defineApplication` now owns platform resources; Honeycrisp and Vocab no longer own SQLite platform leaves. Keep this declaration shape. |
| Library acquisition | `packages/data/src/store/browser.ts:openAppData` constructs `createAppSqlite`, acquires its library claim, discovers a generation, and attaches sync using the captured Account. `discoverGeneration` is now below line 1250. `resolveGeneration` reaches the same algorithm for the independent-device reproduction. |
| SQLite and exclusion | `packages/device/src/owner.ts` owns named files and physical close. `library-claim.ts` keys the claim by app/authority/principal; `browser-sqlite.worker.ts` encodes the same coordinates in an OPFS filename. Native `apps/epicenter/src-tauri/src/sqlite.rs` uses `apps/<app>/accounts/<authority>/<principal>/sqlite/<name>.sqlite`. |
| Blobs | `packages/app/src/browser.ts` constructs local and remote capabilities from Account. `packages/blobs/src/browser.ts:browserBlobStoreName` supplies the IDB name; native `blobDestination` carries app plus account scope. `packages/server/src/routes/blobs.ts` still uses `blobKey(principalId, blobId)` for upload, read, and delete. |
| Recording | `packages/recorder/src/browser.ts` closes over app/Account and writes to that blob store. `desktop.ts:wrap` compares the recovered native recording's app, authority, and principal. Both need library identity added together; browser recovery is document-local, not durable native capture recovery. |
| Local erasure | `eraseGenerations` takes library exclusion and deletes only discovered data-generation IDBs. `eraseBrowserBlobStore` is a separate operation; named SQLite deletion is separate again. No whole-library purge is established by this API. |
| Actor-only capabilities | Session `create-session-auth.ts` still pins `epicenter-api`; `instance-server.ts` derives an authority from the canonical origin. `packages/device/src/secrets.ts` also scopes by app/actor. Inference, billing, and user credentials stay actor-bound; Shared must not redirect them. |
| Host forwarding and boot | `apps/epicenter/src/server.ts` relays account HTTP through its captured Account. Destination routes must survive HTTP and socket validation. Honeycrisp/Vocab retain `.openAccount(account)`; Whispering retains explicit Local/Account branching plus the unfinished recovery guard. |

Nested `apps/self-host/AGENTS.md` still prohibits named sessions, and
Honeycrisp's instructions still describe account-only boot. Those describe the
old target and conflict with the user-selected ADR-0375 direction. No file below
those boundaries changes here. Reconcile those instructions when the relevant
production checkpoint implements that direction; do not silently inherit the
old token-only outcome.

### Initial-generation contract candidate

Proposed wire operation: `POST <authorized-library-data-collection>/initial`.
For self-hosted named libraries, the candidate collection is
`/api/apps/<appId>/libraries/<personal|shared>/data/<dataId>/generations`;
Personal derives its owner from the bearer. Cloud retains its existing
`/api/data/v1/<dataId>/generations` collection and would add `/initial` there.
These request paths are distinct from the storage namespaces below.
The corresponding candidate self-host sync and blob paths are
`/api/apps/<appId>/libraries/<personal|shared>/sync?dataId=<dataId>&generation=<n>&cursor=<position>`
and `/api/apps/<appId>/libraries/<personal|shared>/blobs/<blobId>`. All enter the
same destination authorization boundary; ticket operations bind that destination.
The spelling is unshipped, and final parsers must reject malformed coordinates.
The body is an opaque complete seed snapshot, bounded by the same ingress limits
as an import. The server does not need the application's schema or a sign-in
provider to coordinate it. This operation is separate from explicit generation
import. It returns an admitted generation number; the client fetches that
number's canonical snapshot and log position before caching. A losing client
must never cache its submitted seed under the winner's number.

The library/data ledger owns a durable singleton initial selection and the
monotonic generation allocator. In one transaction it returns the existing
selection, adopts the newest admitted generation if history already exists, or
reserves one number and records it as the initial selection. Failed explicit
import reservations remain gaps and are never reused. Once recorded, the
initial selection is immutable. An explicit later import adds history; it does
not rewrite this selection or existing replicas.

The server coordinator then asks that generation's authority to initialize its
first snapshot atomically if absent. The first complete write wins. Every retry
returns success for an already initialized authority without replacing bytes;
this requires a new internal authority operation, since today's import POST
rejects an existing log. Only after confirmed durable storage does the
coordinator admit the generation in the ledger. Bootstrap GET already checks admission. Socket upgrades currently skip it
(`mount.ts` explicitly relies on principal-only isolation); they must gain an
admission gate before reaching the authority. The new live-route evidence
confirms that an unadmitted socket reaches the authority while its snapshot GET
returns 404. This is a required production change, not an existing guarantee. `admit` is an internal capability, never proof a
client can assert.

Reservation, snapshot storage, and admission are separate durable commits. A
crash before reservation commits leaves no selection; a crash after reservation
allows another admitted requester to initialize the same number. A crash after
snapshot storage allows another request to confirm storage and admit it. A lost
response after admission returns the same number on retry. A late initializer
cannot overwrite that snapshot, including after live edits have started. No
initializer lease, leader user, timeout-based reallocation, or client mutex is
needed. Admission at the request boundary still controls who can enter this
operation; removal during in-flight work belongs to checkpoint 2's contract.

Cache-first behavior stays: open an existing local generation without network
access; otherwise list admitted history and choose its maximum. Only an empty
list invokes `/initial`. A failed list remains a retryable error. Concurrent
explicit imports can intentionally introduce different histories; this operation
does not promise automatic Shared rebuild convergence. Schema disagreement
between app versions remains the existing snapshot-open compatibility boundary.

The prototype uses two SQLite files, one ledger and one snapshot authority.
It tests 12 interleaved initializers using independent database connections and
restart after each durable boundary. SQL statements make whole-snapshot writes
atomic. This is not workerd, actual process termination during disk writes,
production payload limits, live socket editing, or attachment convergence proof.
A Worker integration test must establish those runtime guarantees before the
operation enters production. Keeping the existing authority's no-overwrite rule
is necessary; interpreting a failed initialization as permission to allocate a
new default is forbidden.

### Address contract candidate

Use these exact example coordinates:

- App `so.epicenter.notes`, data `so.epicenter.notes`, generation `1`, blob `b1`, SQLite file `search`.
- Server A `https://a.example`, authority `instance-68747470733a2f2f612e6578616d706c65`.
- Server B `https://b.example`, authority `instance-68747470733a2f2f622e6578616d706c65`.
- Actors `(A, alice)`, `(A, bob)`, `(B, alice)`, `(B, bob)` are four identities. Only trusted installation composition assigns authority; server metadata cannot claim `epicenter-api`.

For either origin S, let H be that origin's authority above and U be `alice` or
`bob`. These templates expand independently for all four actors:

| Coordinate | Personal | Shared |
| --- | --- | --- |
| Actor | `(H, U)` | `(H, U)` |
| Remote library within S | `apps/so.epicenter.notes/libraries/personal/U` | `apps/so.epicenter.notes/libraries/shared` |
| Local replica root R | `epicenter/so.epicenter.notes/accounts/H/U/libraries/personal` | `epicenter/so.epicenter.notes/accounts/H/U/libraries/shared` |

Remote document names append `/data/so.epicenter.notes/generations/1`; their
ledger omits `/generations/1`. Remote blob keys append `/blobs/b1` to the remote
library. Deployment storage namespaces separate the same key on servers A and
B. Both Alice and Bob on A therefore resolve to the qualified storage coordinate
`(https://a.example, apps/so.epicenter.notes/libraries/shared/data/so.epicenter.notes/generations/1)`
and the corresponding Shared blob, through their own credentials. The prototype
represents remote roots as `{ origin, root }`; a storage root is not an HTTP endpoint.

Local documents append `/data/so.epicenter.notes/1` to R. The blob IDB is
`R/blobs`, containing key `b1`. Recording destination and recovery comparison
use the complete R identity. A logical browser SQLite tuple is
`["so.epicenter.notes","account",H,U,"shared","search"]` (or `"personal"`).
Its filename is `/` plus `encodeURIComponent(JSON.stringify(tuple))` plus
`.sqlite`, matching the current encoding mechanism with one added coordinate.
Native files use `apps/so.epicenter.notes/accounts/H/U/libraries/shared/sqlite/search.sqlite`
under the installation root. Library exclusion uses
`epicenter.store:library:["so.epicenter.notes",H,U,"shared"]`; data and blob
resource locks derive from their complete local names. These scopes deliberately
omit generation for library-wide SQL, blobs, recording, and exclusion. A
recording must additionally retain any generation needed by its row attachment
workflow; this experiment does not implement that workflow.

The matrix test asserts eight distinct local scopes across two servers, two
actors, and two destinations for documents, blobs, SQL, recording, and locks.
It asserts equal remote Shared roots for Alice/Bob on A, unequal Personal roots,
and separate app/server roots. These are address comparisons, not evidence that
an outbox has been prevented from uploading through a replaced Account.

Cloud Personal preserves `epicenter-api` and every historical mapping:
`principals/U/data/<dataId>/generations/<n>`, `principals/U/blobs/<blobId>`,
local `epicenter/<app>/accounts/epicenter-api/U/data/<dataId>/<n>` and its
sibling blob IDB; SQL tuple `[app,"account","epicenter-api",U,name]` and native
`apps/<app>/accounts/epicenter-api/U/sqlite/<name>.sqlite`; existing app/actor
recording scope and claim bytes. Historical Cloud data is dataId-scoped and
remote blobs are account-wide. This proposal does not invent per-app physical
erasure for that layout.

Local preserves `epicenter/<app>/local/data/<dataId>/1`, its sibling blob IDB,
`[app,"local",name]` SQL tuple, native `apps/<app>/local/sqlite/<name>.sqlite`,
local recording scope, and `epicenter.store:library:[app,null,null]` exclusion.
It makes no server request.

The only proposed durable-address additions are named-user self-hosted Personal
and Shared roots and their local library coordinate. Preserve all existing
`instance` bytes at their old addresses. They are not assigned to the first
named user, aliased to Shared, or erased. Origin aliases remain distinct; moving
an installation requires an explicit data transition. These candidates remain
outside production pending an ADR and selected-runtime verification.

### Authorization evidence boundary

`contract.ts:authorize` uses test-only bearer values `alice` and `bob`, derives
the Personal owner, rejects every explicit owner parameter, and refuses missing
or unknown identities, Cloud Shared, unknown libraries, and invalid app IDs.
The authorized destination and actor remain separate. App admission is not a
new permissions model: all admitted self-hosted users can use every app's Shared
library. This tests the proposed policy as a function; production HTTP/socket
parsers, sessions, tickets, removal, and host forwarding still need integration
coverage. GET/PUT blob tickets currently last 120/300 seconds and sockets 600
seconds. This checkpoint establishes no stronger removal guarantee.


### Independent checkpoint review and adjudication

A read-only GPT-6 reviewer independently reconstructed the evidence and live
owners using `design-review` and `post-implementation-review`. It reran the
focused suite before repairs: 50 passed, 204 assertions. Its verdict was to
retain the ownership split and close checkpoint 1 as prototype evidence after
two corrections. The coordinator accepted both:

1. Add the missing socket-admission requirement. The new live-mount test proves
   an unadmitted upgrade reaches an authority while the equivalent bootstrap GET
   is refused. The production gate and a test that refusal prevents authority
   access are now explicit checkpoint 3 work.
2. Separate storage coordinates from wire URLs. The prototype now returns
   `{ origin, root }`, its matrix compares those coordinates, and the contract
   names request paths separately. No historical Cloud endpoint is invented.

The reviewer supported ledger-owned initial selection, authority-owned complete
initialization, and one captured App binding for every library resource. This
removes unconditional import allocation from normal first opening and avoids
leases, leader users, reservation recycling, and a public LibraryManager.
Local producer exclusion and explicit import still own distinct behavior.
No additional structural rewrite or product decision was accepted here.

Deferred proof is explicit: the selected runtime needs two clients with different
seed bytes that both cache the canonical winner, actual request/socket gates,
crash/restart coverage, live log catch-up, attachments, and outbox retirement.
The twelve prototype clients interleave synchronous SQLite operations on
independent connections; they do not establish simultaneous process contention.
Cleanly closing and reopening committed files does not simulate power loss
inside a transaction. The policy function does not implement sessions or parsers.

Reviewer file inventory (focused excerpts and symbol searches included):

```text
.agents/skills/
|-- design-review/SKILL.md
|-- post-implementation-review/SKILL.md
|-- greenfield-clean-breaks/SKILL.md
`-- testing/{SKILL.md,references/honest-tests.md}
docs/adr/
`-- 0375-library-ownership-is-local-personal-or-shared-within-one-deployment.md
specs/
|-- 20260909T004225-library-ownership-execution.md
`-- 20260909T062714-library-ownership-api.review.md
packages/
|-- app/src/{index.ts,browser.ts}
|-- auth/src/{create-session-auth.ts,instance-server.ts}
|-- blobs/src/browser.ts
|-- data/
|   |-- evidence/library-ownership/device.ts
|   `-- src/{store/browser.ts,store/browser.test.ts,sync/authority.ts}
|-- device/src/{library-claim.ts,owner.ts,browser-sqlite.worker.ts}
|-- recorder/src/{browser.ts,desktop.ts,recording.ts}
|-- server/
|   |-- package.json
|   |-- evidence/library-ownership/{initial-generation.ts,contract.ts,foundation.test.ts}
|   `-- src/{principal.ts,store-sync/{authority.ts,generations.ts,mount.ts,browser-dial.test.ts}}
`-- sync/src/generations-route.ts
/tmp/library-checkpoint-1/status.txt
```

The coordinator reread all repaired files, checked that storage roots and wire
paths remain separate, and checked the admission requirement against the live
mount. The added test records current behavior for this investigation; production
integration must replace its expectation with rejection before authority access.

## Checkpoint 2 independent reviews

After checkpoint 1 committed as `ea8f2d254d`, an independent read-only review
examined the next production decision. It recommended separating issuer identity
from session lifetime before selecting runtime or sign-in infrastructure. The
coordinator implemented that slice and requested a second review of the new
production delta, rather than repeating the checkpoint 1 investigation.

The second review accepted required `authorityId`, generic `SessionAuthClient`
and `CallbackAuthClient`, and explicit Cloud management composition. It confirmed
that `Object.assign` preserves the original auth object's getter and disposal
behavior, and found no task change to the private bearer lifetime. The proposed
record is ADR-0382. No additional factory or exported bearer core was warranted.

It caught an incomplete session-storage test fixture whose disposal logged an
error despite passing assertions. The coordinator supplied a functioning
Map-backed store and reran `bun test packages/auth/src/session-authority.test.ts`:
three passed, 18 assertions, no cleanup diagnostic. The independent reviewer had
rerun the broader issuer/lifetime suite: 49 passed, 178 assertions. The execution
spec records the package and consumer failures and their pre-edit reproductions.

The next sign-in proposal is operator-assisted passkey enrollment and recovery,
with a stable principal preserved through recovery and durable admission checked
at both session issuance and resource access. Worker-first is recommended because
it has sync. Both remain product questions. The review explicitly refused to
infer a working enrollment system from installed passkey hooks or reuse Cloud's
required email field with fabricated values. No provider, database adapter,
enrollment protocol, or removal implementation was selected here.

Files read across the two reviews (focused excerpts included):

```text
.agents/skills/
|-- design-review/SKILL.md
|-- post-implementation-review/SKILL.md
|-- greenfield-clean-breaks/SKILL.md
|-- auth/SKILL.md
`-- testing/{SKILL.md,references/honest-tests.md}
docs/adr/
|-- 0375-library-ownership-is-local-personal-or-shared-within-one-deployment.md
`-- 0382-session-composition-selects-issuer-identity-and-management-capabilities.md
specs/
|-- 20260909T004225-library-ownership-execution.md
`-- 20260909T062714-library-ownership-api.review.md
apps/
|-- self-host/{AGENTS.md,README.md,package.json,server.ts,worker-configuration.d.ts,worker/index.ts}
|-- api/{worker/index.ts,ui/src/lib/dashboard/runtime.test.ts}
`-- epicenter/src/{desktop-auth-authority.ts,account-transport.test.ts}
packages/
|-- auth/
|   |-- README.md
|   `-- src/
|       |-- {auth-contract.ts,auth-types.ts,browser-auth.ts,create-session-auth.ts}
|       |-- {hosted-browser-redirect-auth.ts,account-management.ts,index.ts,instance-server.ts}
|       |-- session-handoff-client.ts
|       `-- {session-authority.test.ts,account-lifetime.test.ts,contract.test.ts,refusal-is-not-an-identity-change.test.ts}
|-- app/src/{sync-subprotocol.test.ts,ai.test.ts}
`-- server/
    |-- node_modules/@better-auth/passkey/dist/index.mjs
    `-- src/
        |-- {create-cloud-context-middleware.ts,principal.ts}
        |-- auth/{base-config.ts,create-auth.ts,oauth-resource.ts,plugins.ts,session-handoff.ts,session-policy.ts}
        |-- db/schema/auth.ts
        |-- middleware/require-auth.ts
        |-- routes/{auth.ts,blobs.ts}
        `-- store-sync/{mount.ts,authority.ts,browser-dial.test.ts}
/tmp/library-checkpoint-2/
|-- {changed.txt,delta.patch}
|-- {baseline-auth-tests,auth-tests,baseline-auth-types,auth-types}.txt
`-- {baseline-desktop-tests,consumer-tests}.txt
```
