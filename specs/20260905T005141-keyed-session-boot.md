# The boot is a keyed session, and sync never stops

**Date**: 2026-09-05
**Status**: In Progress
**Owner**: Braden Wong
**Branch**: braden-w/app-schema-derive-export-import (four commits, no PR yet)

## How to read this spec

```txt
Read first:
  One Sentence
  Current State
  Target Shape
  Deletion prizes
  Implementation Plan (four waves)
  Verification

Read if changing the design:
  Research Findings (every claim below was verified against source)
  Design Decisions
  Edge Cases

Do not read as instructions:
  ADR-0088, ADR-0232, ADR-0344 (all amended or superseded by this work)
```

## One Sentence

An application's data session becomes a value the Svelte tree owns, keyed on
the signed-in principal, and the sync driver runs for as long as the store is
open instead of stopping for good on a credential refusal.

## Overview

Replace the four-state `epicenter.state` machine, its Svelte mirror
(`fromEpicenter`), and the document reload on auth change with: a handle whose
`open()` returns a `DataSession { opened, close, erase }`, a boot node that reads
auth reactively and keys one session component on `principalId`, and a driver
that reports a credential refusal as data and keeps dialling. Two shared screens
replace three inlined copies.

## Motivation

### Current State

Auth is read once and deliberately not tracked; a principal change reloads the
document; the handle publishes four states that an adapter mirrors into a rune.

```svelte
<!-- apps/honeycrisp/src/routes/+page.svelte (today) -->
const signedOut = authClient.state.status === 'signed-out';
if (!signedOut) void epicenter.open();

{#if signedOut}
	... 25 lines of sign-in screen, duplicated in vocab and whispering ...
{:else if epicenter.state.status === 'ready'}
	<StoreShell data={epicenter.state.data} />
{:else if epicenter.state.status === 'failed'}
	... 40 lines of cannot-open screen, duplicated in vocab and whispering ...
{:else}
	<Loading class="h-dvh" label="Opening your notes…" />
{/if}
```

```ts
// packages/data/src/sync/attach.ts (today): a refused credential stops the driver forever
if (isOpenWebSocketDenial(cause) && cause.permanence === 'permanent') { denied(); return; }
```

```ts
// packages/auth/src/svelte/reload-on-auth-change.ts (today)
if (identityChanged || credentialAcquired) window.location.reload();
```

This creates problems:

1. **Three lifetimes for two facts.** The store's numbered history, the page's
   "auth generation", and the driver's dial counter are all called
   `generation`. The middle one exists only because the reload exists.
2. **The driver's "stop for good" forces the reload.** After a Reconnect, only a
   fresh page dials again, so `reauth-required -> signed-in` had to reload.
3. **A hand-built state machine mirrored into a rune** is the shape the repo's
   Svelte skill names as the anti-pattern; `{#await}` over a promise is the
   machine in the template.
4. **Screens triplicated and already drifting**: only Honeycrisp's loading
   state carries a label.
5. **"cache hit" names the replica.** The IndexedDB record holds the outbox of
   unsent edits; a reader who believes it is a cache writes a clear-cache
   repair that loses notes.

### Target Shape

```svelte
<!-- apps/whispering/src/routes/(app)/+layout.svelte -->
{#if auth.state.status === 'signed-out'}
	<SignInScreen {auth} appName="Whispering" noun="recordings" />
{:else}
	{#key auth.state.principalId}
		<RecordingsSession>{@render children()}</RecordingsSession>
	{/key}
{/if}
```

```svelte
<!-- apps/whispering/src/routes/(app)/_components/RecordingsSession.svelte -->
<script lang="ts">
	let session = $state.raw(epicenter.open());
	$effect(() => () => void session.close());
	async function forgetDevice() {
		const erased = await session.erase();
		session = epicenter.open();
		return erased;
	}
</script>

{#await session.opened}
	<Loading class="h-dvh" label="Opening your recordings…" />
{:then { data, error }}
	{#if error !== null}
		<CannotOpenScreen appName="Whispering" noun="recordings" {error} retry={() => (session = epicenter.open())} />
	{:else}
		<WhisperingShell {data} {forgetDevice}>{@render children()}</WhisperingShell>
	{/if}
{/await}
```

```ts
// @epicenter/app
type DataSession<T> = {
	opened: Promise<Result<ReplicaData<T>, DataOpenError>>;
	close(): Promise<void>;                          // idempotent; no-op once superseded
	erase(): Promise<Result<void, StoreError>>;      // closes this session, erases this account's copy
};
epicenter.open(): DataSession<T>;   // synchronous; captures account.state.principalId NOW
epicenter.close(): Promise<void>;   // the live session's close; HMR disposer and tests
```

```ts
// @epicenter/data/sync: one callback, classification as data
closed(refusal?: SyncRefusal): void;     // SyncRefusal is a closed union in @epicenter/sync
status().refusal: SyncRefusal | undefined;  // set on a refused dial, cleared on open
```

## Deletion prizes

State each prize so the adversary can check it was collected, and hunt for more.

| Prize | Why it falls |
| --- | --- |
| `reloadOnAuthChange` + test + three root-layout effects | sign-out flips `{#if}`; a switch remounts `{#key}`; sign-in and Reconnect are document navigations already |
| `fromEpicenter` + test, `epicenter.state`, `onStateChange`, `EpicenterState`, the `closed/opening/ready/failed` vocabulary | `{#await session.opened}` is the machine in the template |
| `ReactiveAuthClient` brand, the `authClient` export, "boot reads must not track" prose | boot reads track now |
| `epicenter.account`, `epicenter.eraseReplica` | no app reads `account`; erase moves to the session that owns the swap |
| `denied()`, `permanence`, `isOpenWebSocketDenial` as control flow | a refusal is decided locally with no network; a 30s-capped retry costs nothing |
| the "auth generation" concept, every "page lifetime is one auth generation" sentence | no reload, no page-lifetime generation |
| three inlined sign-in and cannot-open screens | two shared components take `appName` and `noun` |
| `epoch` machinery in `createEpicenter` | collapses to `current === session` identity checks |
| the `closed`-and-`opening`-are-one-screen comment at every boot node | there is no `closed` |

Candidates the adversary should weigh (not committed to): `DataSessionError.SessionClosed` (kept: a session closed while opening must not resolve Ok); folding `attachStoreSync` and `persistOnHide` into `openDatabase` (deferred, see Adjacent Work); `Epicenter<never>` overload for Local Mail (kept: it is the whole surface Local Mail needs).

## Research Findings

Every claim here was checked against installed source or a test in this repo.

| Claim | Evidence |
| --- | --- |
| Svelte 5.56 creates the new `{#key}`/`{#if}` branch BEFORE destroying the old one | `node_modules/.bun/svelte@5.56.3/node_modules/svelte/src/internal/client/dom/blocks/branches.js`: `ensure()` runs `branch(fn)` for the new key, then `#commit()` pauses/destroys the old. So a keyed child that calls `open()` at init runs before the sibling's cleanup. The handle must serialize sessions; the tree cannot. |
| A cleanup-only `$effect` is the skill's sanctioned shape | `.agents/skills/svelte/references/lifecycle-and-reactivity.md` line 25 |
| `{:then { data, error }}` destructures and narrows | svelte2tsx emits `const { data, error } = $$_value` |
| A search-param `goto` never remounts the page | SvelteKit `write_root.js` binds page components with no `{#key}` |
| Hosted sign-in is a document navigation | `packages/auth/src/oauth-launchers/launchers.ts:34` sets `window.location.href`; the extension launcher (`:84`) completes inline |
| The desktop broker never emits a state change | `packages/auth/src/desktop-broker-auth.ts` |
| A refused credential is decided locally, no network | `oauth-credential-authority.ts` `authorize()`: `persistedAuth === null || networkAuthPaused` returns denied before any fetch |
| `'auth-unavailable'` means two things today | retry in `oauth-credential-authority.ts:258`; never in `desktop-broker-auth.ts:159` and `same-origin-cookie-auth.ts:249` |
| The principal is in the local address (v5) and `BoundElsewhere` is gone | uncommitted waves 1 to 3 of the other session; ADR-0348 |
| Context is the right carrier for the opened app object | it says "below this node a resolved open exists"; a singleton makes every read `T \| undefined`, stales closures on a switch, and turns `boot-node.test.ts` hollow. Verified by adversarial comparison; `docs/articles/context-is-not-reactive-but-the-tree-is.md` records the same rule |
| Module-scope state outside the keyed child is device-scoped or principal-keyed | device-config, secrets (device by design), popover profile query keyed `['account-profile', principalId]`, Vocab inference connections (static hosted catalog, `auth.fetch` per call), desktop blob leaf latched read is correct per-process |

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Session is a value, not handle state | 1 evidence | `open(): DataSession` | Svelte's create-before-destroy order; only handle-owned serialization makes the tree order irrelevant |
| Open in the child's script body, not an effect | 2 coherence | script body + cleanup-only `$effect` | skill's prop-keyed resource rule; safe because the handle serializes |
| Driver never stops | 1 evidence | delete `denied()` | refusal is local and free; deleting it deletes the reload's last reason |
| Refusal is typed data on `closed()` | 2 coherence | `closed(refusal?: SyncRefusal)` | one callback; sidebar maps exhaustively with `satisfies Record` |
| Delete `permanence` entirely | 2 coherence | delete | dead data invites a future consumer to branch on it again |
| Split `auth-unavailable` | 1 evidence | `'no-credential-model'` for the never-case | code collision exposed once `permanence` goes |
| Erase lives on the session | 1 evidence | `session.erase()`; component reopens | the handle cannot swap a value a component owns |
| Principal captured at `open()` call | 2 coherence | read `account.state` synchronously in `open()` | the session answers for the principal that created it |
| Shared screens over inlined copies | 3 taste | `SignInScreen`, `CannotOpenScreen` in app-shell | three byte-identical four-arm screens differing only in the noun; constraint: delete the prose arguing the reverse in the same commit |
| `appName` and `noun` as two string props | 3 taste | no `vocabulary` object | an object with two fields whose only job is to sound like a concept |
| Context stays for the app object; singleton stays for the handle | 1 evidence | unchanged | see Research Findings |
| ADR handling | 3 taste | supersede 0232; amend 0088 and 0344 | 0232's title states both reversed rules |
| One PR, driver commit before session commit | 2 coherence | B before C | C without B needs a throwaway redial mechanism |
| Fold sync into `openDatabase` | Deferred | Deferred | not required; see Adjacent Work |

## Architecture

```txt
(app)/+layout.svelte               reads auth, decides who
└─ {#if signed-out}  SignInScreen
└─ {#key principalId}
   └─ <Noun>Session               open at init, {#await}, close on unmount, erase -> reopen
      ├─ Loading
      ├─ CannotOpenScreen         error + retry
      └─ Shell                    fromData once, setContext, chrome
         └─ {@render children()}  routed pages, full history

@epicenter/app handle (module singleton, inert)
  open()  -> if a session exists: previous.close().then(reallyOpen)   [serialized]
  close() -> live session's close
  session.close() on a superseded session -> no-op

@epicenter/data/sync driver (lives exactly as long as the store)
  dial -> transport.openWebSocket(address) -> socket | throws OpenWebSocketDenied{code}
       -> closed(refusal?)  -> backoff (30s cap) -> dial again, forever
  status(): { connected, cursor, failures, refusal?, lastReconnect }
```

## Call sites: before and after

### Honeycrisp boot node

**Before** (`apps/honeycrisp/src/routes/+page.svelte`, working tree): 130 lines, one-shot untracked read, four-arm `{#if}` over `epicenter.state`, two inlined screens.

**After**: the Target Shape above, with `notes` for `session`, `StoreShell` for the shell, and no `children` (one route).

**Semantic shift to flag**: `epicenter.state` has no consumers left; grep `epicenter.state`, `onStateChange`, `fromEpicenter`, `reloadOnAuthChange`, `authClient` across `apps/` and `packages/`.

### Sync status in the sidebar

**Before** (`apps/honeycrisp/src/routes/components/StoreShell.svelte:34`):

```ts
return status?.denied === false ? status : undefined;
```

**After**:

```ts
const line = $derived(
	sync.refusal !== undefined
		? ({ 'signed-out': undefined, 'reauth-required': 'Sign in to sync',
		     'auth-unavailable': 'Offline', 'no-credential-model': undefined }
		   satisfies Record<SyncRefusal, string | undefined>)[sync.refusal]
		: sync.connected ? `Synced · ${sync.cursor} changes received` : 'Offline',
);
```

**Semantic shift to flag**: `failures` climbs forever under a local refusal (a desktop window is refused every 30s for the page's life); never render "N failed retries" while `refusal` is set.

### Forget this device

**Before** (`apps/honeycrisp/src/routes/components/Sidebar.svelte:52-60` + popover): `epicenter.eraseReplica()` then `window.location.reload()`.

**After**: the popover calls the `forgetDevice` the session component handed down through `createHoneycrisp`; no reload. Success bootstraps a fresh copy from the account; failure reopens the copy still there.

## Implementation Plan

Each wave is one commit that leaves the tree green. An Opus implementer builds
it; I review the diff; a Fable adversary reviews it read-only and hunts for
deletion prizes; accepted findings go back to the same implementer; I stage
named files and commit.

### Wave A: shared screens

- [ ] **A.1** `packages/app-shell/src/boot-screens/`: `SignInScreen.svelte` (`auth`, `appName`, `noun`; sign-in pending state and error line as the inlined copies have them), `CannotOpenScreen.svelte` (`appName`, `noun`, `error`, `retry`), `open-failure.ts` with `openFailure(error, { appName, noun }): { message, repair: 'retry' | 'none' }` and its test table. Export from app-shell's package.json.
- [ ] **A.2** Replace the inlined blocks in `apps/honeycrisp/src/routes/+page.svelte`, `apps/vocab/src/routes/+page.svelte`, `apps/whispering/src/routes/(app)/+layout.svelte`. Keep today's `epicenter.state` chain; only the two screen arms change.
- [ ] **A.3** Delete the prose arguing against shared screens: the explanation block in Honeycrisp's page, the cross-references in Vocab and Whispering, `apps/honeycrisp/AGENTS.md` boot Don'ts, the root `AGENTS.md` worked example (repoint it at `open-failure.ts`). Carry the wave-3 fixes if the other session did not: no address printed under `LocksUnsupported`; sign-in pending state not cleared in `finally`.
- [ ] **A.4** Gates: typecheck app-shell and the three apps; `bun test` for app-shell and each app's `boot-node.test.ts`.

### Wave B: the driver never stops

- [ ] **B.1** `packages/sync`: `SyncRefusal = 'signed-out' | 'reauth-required' | 'auth-unavailable' | 'no-credential-model'`; `OpenWebSocketDenial { name, message, code: SyncRefusal }`; delete `permanence`. Move `BearerAuthorization.code`'s union in `packages/auth/src/credential-authority.ts` onto it.
- [ ] **B.2** `packages/auth`: desktop broker and same-origin cookie clients throw `code: 'no-credential-model'`; OAuth authority keeps `'signed-out' | 'reauth-required' | 'auth-unavailable'`. Fix contract tests asserting `permanence`.
- [ ] **B.3** `packages/data/src/sync/connection.ts`: `SyncAttempt.closed(refusal?: SyncRefusal)`; delete `denied()`; `status().refusal`, set on a refused dial and cleared on `opened`; `lastReconnect` gains `'refused'`; rename `generation` -> `attempt`, `attempts` -> `failures` (and the `backoff(failures)` parameter). Rewrite the doc comment: no "stops for good".
- [ ] **B.4** `packages/data/src/sync/attach.ts`: classification becomes `closed(isOpenWebSocketDenial(cause) ? cause.code : undefined)`; `onTransportError` still fires for non-denial rejections only. Delete the "permanent denial" comments.
- [ ] **B.5** Tests: `connection.test.ts` "denied stops dialling" becomes "a refused dial is reported and dialled again; a refusal clears when a socket opens"; `attach.test.ts` permanent/transient tests become refusal-code tests; `transport.test.ts` unaffected.
- [ ] **B.6** Consumers of `.denied`: `apps/honeycrisp/src/routes/components/StoreShell.svelte:34`, `apps/whispering/src/lib/whispering/app.ts:154`, and the sidebars' copy per the call site above.
- [ ] **B.7** New ADR `docs/adr/0350-a-data-session-is-a-value-the-tree-owns-and-sync-runs-for-the-life-of-the-store.md`, status Proposed, superseding 0232, with an `Unbuilt:` line naming wave C's half. Update `docs/adr/README.md`. Amend 0232's header.
- [ ] **B.8** Gates: typecheck sync, auth, data, app, app-shell, the three apps; `bun test` for sync, auth, data/sync, app.

### Wave C: sessions as values (tests first)

- [ ] **C.1** Tests before code, in `packages/app/src/index.test.ts` and `client-owned-data.test.ts` (renamed with the file in wave D): `open()` while a `close()` is in flight chains behind it; `open()` while a session is held closes it first and the second session resolves the new store; `close()` on a superseded session is a no-op; `open()` captures the principal read at the call even when the real open runs after the previous close; a session closed while opening resolves `Err(SessionClosed)`; `erase()` closes this session and erases this account's copy; the HMR path `epicenter.close()` closes the live session.
- [ ] **C.2** `packages/app/src/index.ts`: `DataSession<T>`; `open()` synchronous; delete `state`, `onStateChange`, `EpicenterState`, `account`, `eraseReplica`, the `epoch`/`current`/`closing` trio in favour of a single `live: { session, closing?: Promise<void> }`; keep `close()`; keep `DataSessionError.SessionClosed` and `OpenerThrew`. `openReplica` takes the address (read at the call) rather than the client.
- [ ] **C.3** `packages/svelte`: delete `from-epicenter.svelte.ts` and its test; README. `packages/auth`: delete `svelte/reload-on-auth-change.ts` and its test; `fromAuth` returns `TClient`; delete the brand and its rationale prose.
- [ ] **C.4** Platform leaves: one `auth` export per app (`apps/*/src/lib/platform/auth.*.ts`); HMR disposers keep `authClient[Symbol.dispose]` semantics on `auth`. `apps/*/src/lib/epicenter.svelte.ts` -> `epicenter.ts` (nothing reactive left); HMR disposer returns `epicenter.close()`.
- [ ] **C.5** Boot nodes and session components: `apps/honeycrisp/src/routes/+page.svelte` + `components/NotesSession.svelte`; `apps/vocab/src/routes/+page.svelte` + `components/ConversationsSession.svelte`; `apps/whispering/src/routes/(app)/+layout.svelte` + `_components/RecordingsSession.svelte` taking `children`. Root layouts lose `reloadOnAuthChange`. `/auth/callback` pages import `auth`.
- [ ] **C.6** Shells take raw `ReplicaData` and call `fromData` once at init: `StoreShell`, `VocabShell`, `WhisperingShell`; `createHoneycrisp({ data, forgetDevice })`; Sidebar's `onForgetDevice` calls it; popover drops `window.location.reload()` after forget.
- [ ] **C.7** `boot-node.test.ts` in all three apps: `BOOT_NODE` is the session component; the shell assertion stands; the callback assertions stand.
- [ ] **C.8** Prose that becomes false: citations of "a page lifetime is one auth generation" at `from-data.svelte.ts`, `ui-session.ts`, `WhisperingShell.svelte`, `auth-contract.ts`, `same-origin-cookie-auth.ts`, `instance-credential-authority.ts`, `refusal-is-not-an-identity-change.test.ts` (its premise becomes "a refusal must not remount the keyed session"), `account-popover.svelte`, the three `epicenter.svelte.ts` comments; the auth skill's reload section; ADR-0088 amended at "a principal change reloads the page"; ADR-0344 amended at `state`/`open`; the new ADR's `Unbuilt:` line removed.
- [ ] **C.9** Gates: full `bun run typecheck` for every touched package and app; `bun test` for app, svelte, auth, and the three apps' `boot-node.test.ts`; doc-hygiene at or below baseline.
- [ ] **C.10** Module-scope state the reload used to reset, found by the storage audit and verified: `apps/whispering/src/lib/state/manual-recorder.svelte.ts` holds `_current: Recording | null` minted in the old document; `dictation-lifecycle.svelte.ts` holds an `outcome` that can carry a transcript; `apps/vocab/src/lib/state/dictation.svelte.ts` chains deliveries that write into the store. Keep the account controls' `disabledReason` gate so a switch cannot start mid-capture, and reset each of these on the session boundary (the session component's init or the shell's onDestroy), with a one-line comment naming the reload they replace. Verified not at risk: `whispering/queries/audio.ts` is built per shell mount and cleared on its dispose; `recordings/+page.svelte` `rowSelection` is localStorage-persisted and already survived reloads, so it is pre-existing and goes to Adjacent Work.

### Wave D: names, and the spec goes

- [ ] **D.1** `packages/app/src/client-owned-data.ts` -> `replica.ts`; `resolveGeneration` -> `findOrCreateGeneration`; `listGenerations`' failure -> `AuthorityUnreachable({ status })` with a `'retry'` arm in `openFailure` that says sign in when status is 401 or 403; `STORE_GENERATION` -> `ADDRESS_VERSION`; "cache hit / cache miss" prose -> "a copy held on this device"; `syncNoun` -> `noun` on the popover.
- [ ] **D.2** Delete `specs/<this file>`; flip the new ADR to Accepted; `docs/spec-history.md` entry.
- [ ] **D.3** Gates as C.9.

## Edge Cases

### Account switch while the previous open is still acquiring
1. A signs in; `open()` is mid-`resolveGeneration`; A signs out and B signs in.
2. `{#if}` flips to the sign-in screen (old child cleanup calls `close()`), then B's child calls `open()`, which chains behind the close.
3. A's session resolves `SessionClosed` to nobody; B's session opens B's address. The listing fetch has no timeout, so a hung listing delays B; document, do not fix here.

### Degrade to `reauth-required` mid-keystroke
1. Refresh token rejected in the background; `status` changes, `principalId` does not.
2. Neither `{#if}` nor `{#key}` changes; nothing remounts.
3. The driver's next dial is refused with `'reauth-required'`; the sidebar says "Sign in to sync"; editing continues.

### Reconnect in a build whose launcher completes inline
1. Extension launcher returns `completed`; state goes `reauth-required -> signed-in`, same principal.
2. Nothing remounts; the driver's next dial (≤30s) succeeds.

### Forget this device fails
1. `session.erase()` closes, erase refuses (`AlreadyOpen` from another window).
2. The component reassigns `session = epicenter.open()`; the copy is still there and reopens; the popover toasts the failure.

### HMR of the session component
Svelte's HMR wrapper destroys the old effect before creating the new branch (the opposite of `{#key}`), so cleanup closes, then the new script opens and chains. Fine either way because the handle serializes.

## Open Questions

1. **Should `RecordingsSession` also clear Honeycrisp's `?note=` on a principal change?** A note id from A in the URL after switching to B renders "No note selected" today under reload as well. Recommendation: leave it; it is not a regression.
2. **Does the `{#key}` need a credential counter for inline launchers?** No: the driver redials on its own. Keep the key on `principalId` alone.

## Adjacent Work

- Fold `attachStoreSync` and `persistOnHide` into `openDatabase` by adding `openWebSocket` to `DatabaseAccount`, so `openReplica` collapses to resolve then open. Not required; the seam rename `transport: account` is the tell that would bring it back.
- Cross-tab sign-out: no `storage` listener exists, so a sign-out in another tab reaches nobody. True today; one listener under the reactive design.
- Wave-4 multi-window ownership (the other session's outline) is untouched by this work; `AlreadyOpen` keeps its arm.

## Success Criteria

- [ ] `grep -rn "epicenter.state\|onStateChange\|fromEpicenter\|reloadOnAuthChange\|authClient\|\.denied\b\|permanence" apps packages --include=*.ts --include=*.svelte` returns nothing outside git history.
- [ ] `grep -rn "auth generation\|page lifetime is one" apps packages docs/adr/0349*` returns nothing.
- [ ] Every wave's typecheck and tests green; doc-hygiene at or below 24.
- [ ] A Fable first-time-reader pass over every name the four commits touched finds no word with two meanings on the boot path.
- [ ] Four commits, no PR, each revertable alone.

## References

- `packages/app/src/index.ts`, `packages/app/src/client-owned-data.ts` - the handle and opener
- `packages/data/src/sync/attach.ts`, `connection.ts` - the driver
- `packages/sync/src/auth-subprotocol.ts`, `packages/auth/src/credential-authority.ts` - refusal codes
- `packages/auth/src/svelte/*` - adapter and reload gate
- `packages/svelte/src/from-epicenter.svelte.ts`, `from-data.svelte.ts` - adapters
- `apps/{honeycrisp,vocab}/src/routes/+page.svelte`, `apps/whispering/src/routes/(app)/+layout.svelte` - boot nodes
- `apps/*/src/lib/boot-node.test.ts` - the structural test
- `.agents/skills/svelte/references/lifecycle-and-reactivity.md` - the tree-owns-lifecycle rule
- `docs/adr/0088`, `0232`, `0344`, `0345`, `0348` - amended, superseded, or relied on
