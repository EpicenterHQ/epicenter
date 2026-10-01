# Fresh-chat handoff: implement the local/account app clean break

**Status:** Draft

You are the primary Codex execution and integration owner in the Epicenter repo.
Implement [the execution spec](20260907T231907-local-account-app-clean-break.md),
grounded in [ADR-0355](../docs/adr/0355-local-and-account-sessions-share-the-application-data-api.md).
Do the work, not another broad API-design discussion. Read AGENTS.md and relevant
skills before editing. The preceding conversation settled this destination:

```ts
const epicenter = createEpicenter({
  appId: 'so.epicenter.whispering',
  definition,
});
export const app = epicenter.openLocal();
// Separately: epicenter.openAccount(account)

app.account; // Immutable { authorityId, principalId } | null, no credentials.
app.ready;   // Promise<Result<void, OpenError>>.
app.tables.recordings;
app.kv;
app.blobs;
app.sqlite.open('recordings');
app.close();
```

There is one live app, no session.app, resolved-data facade, public scope wrapper,
or supportsRemote/isLocal flags. Account identity determines configured remote
transfer but not current authorization or connectivity. Local transfer attempts
return RemoteNotConfigured. Account identity remains fixed after sign-out retires
transport. Readiness means usable local data, not complete network synchronization.
Close works during acquisition and after readiness. A successful ready promise
never becomes a liveness signal; owners remove consumers when closing.

Apps can export the handle at client module scope, gate once on app.ready, then
import it in descendants. Prefer full app.tables.recordings access. Passing that
same handle through props or framework context is equally supported; no framework
provider is required by the API. A gated child's instance script runs after
readiness; imported module initialization does not. Preserve callback/overlay
lifetimes and account-specific ownership when choosing module boundaries.

The user explicitly authorized a clean break across the repository. Do not build
legacy migrations, import-on-open, fallbacks, compatibility aliases, versioned
root directories, or duplicate old/new public APIs. Temporary repository breakage
is acceptable between slices. Fix all affected consumers and pass final checks.
This is not permission to erase unrelated edits or wipe actual user directories.
Use disposable roots/origins for verification and leave old stores unread.

The stable addresses are epicenter/<app-id>/local/{data,blobs,sqlite} and
epicenter/<app-id>/accounts/<authority-id>/<principal-id>/{data,blobs,sqlite}.
Data has definition/generation children; blobs and named SQL sit outside them.
Named SQL ends in .sqlite and remains local even for account data. Browser
IndexedDB mirrors logical names; browser SQLite uses OPFS with VFS-controlled
physical files. Secrets remain separate. Resolve authenticated stable authority
identity before implementing account addresses; no global server registry is owed.

One runtime opens an address once. Reject duplicate live opening through ready,
preserve the first handle, and allow reopening after completed close. Local and
account handles coexist because their addresses differ. Cross-tab/process storage
coordination is still real. Explicit local-to-account copy/import is a product
operation with new row/blob IDs and source preservation; it remains required and
is different from the refused migration of old storage layouts.

Start with git status and the actual code. The direct-session foundation landed
in `0c329cbb54`, client integration in `23bade0df4`, and auth closeout in
`b589fddf75`. Read `packages/auth/README.md` and ADR-0354 for the resulting
contracts; the retired auth spec is no longer an execution dependency.
`createSessionAuth` owns persisted `{ token, principalId }`. Account still exposes
`principalId`, `baseURL`, `fetch`, `openWebSocket`, and `getProfile`; desktop boot
exposes `{ state, connection }` without credentials. `authorityId` does not yet
exist. This task owns its authenticated binding and propagation, preserving
direct-session retirement and offline identity behavior. Do not restore OAuth
grants or use a URL as authority identity.

Implementation was paused for that auth integration; no local/account code was
changed during the pause. Preserve unrelated dirty changes. If another task is
still editing these owners, inspect its status and sequence overlapping work
before editing. Do not expand another task's scope to implement this spec.
First inspect packages/app/src/index.ts and client-owned-data.ts,
packages/data/src/store/{browser,handles,store,log,persist,persistence}.ts,
packages/auth/src/auth-contract.ts, packages/blobs/src/, packages/device/src/,
apps/epicenter/src/{device,server}.ts, and Whispering's lib/epicenter.svelte.ts,
lib/whispering/recordings.ts, and RecordingsSession.svelte boot component.
Existing comments can be stale; current types and callers are evidence.

Also trace native recording storage in
`apps/epicenter/src-tauri/src/recorder/blob.rs`: it writes bytes independently of
the Bun blob routes. Browser SQLite constructors currently compete for one
origin-wide OPFS pool, and retained SQL handles can reopen after deletion.
Verify those owners while implementing scoped capture and close/delete semantics.

Execute the spec's checkpoints: identity/addresses, lifecycle harness, real local
persistence, blob/SQL composition, owning blob fields and Whispering, final app
consumer sweep. Preserve KV, content, and observation use cases. Local persistence
must not leave writes waiting forever for remote acknowledgment. Propagate SQL
identity through protocol/worker/native boundaries. A shared worker/pool must not
be destroyed when another app still owns a database.

After each meaningful checkpoint, spawn a separate GPT-6 agent for a bounded
read-only review of the diff and real callers. The user explicitly requested
this. Ask for useful collapses: duplicate facts, forwarding wrappers, repeated
identity binding, and readiness/ownership layers with no distinct job. Require
before/after call sites, deletion benefit, and behavior cost. You keep authorship,
judge findings against evidence, integrate valid changes, and rerun affected
checks. Do not invoke Claude. Do not stop for naming approval or preserve weak
shapes merely because the spec listed them. Surface material changes to the
settled product promise; record durable new mechanisms in focused ADRs.

Use Bun. Run targeted tests/typechecks while building and actual browser/native
smokes for persistence and streaming. The spec lists real commands. Compile-only
examples and in-memory tests do not prove restart durability. The earlier writing
pass compiled 29 Svelte article snippets and passed whitespace checks; it did not
implement or verify this runtime. Doc hygiene has known unrelated findings.
No deployment or production admin operation is requested.

Finish with the working implementation, relevant final checks, removed old paths,
updated current docs/guidance, and a concise evidence report. Keep checkpoints
current across context resets. Delete the spent spec and this handoff when done,
retaining ADRs and normal spec history; remove or replace the ADR's temporary
spec link in the same change. If an external condition blocks runtime
verification, name exactly what remains unverified instead of claiming success.
