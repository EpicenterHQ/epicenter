# Give each application page one fixed library

**Date:** 2026-09-08
**Status:** Draft
**Owner:** The implementing agent owns execution, verification, and integration.

## One sentence

An application page opens one library, and changing libraries closes that
application before starting a fresh page.

The user accepted this destination after independent design review. The durable
record is [ADR-0369](../docs/adr/0369-an-application-page-owns-one-library-and-changing-it-ends-the-page.md).
Current code still replaces sessions inside `AppBoot`. Completion means real
browser and desktop departure prove close-before-selection, all application
callers use fixed ownership, and the replacement path is deleted.

This self-contained plan is the next application-lifetime slice of the broader
local/account clean break. Its untracked working plan,
`specs/20260907T231907-local-account-app-clean-break.md`, remains preserved and
retains import, transfer, and whole-library erasure obligations.

## Current evidence

Baseline: `febfefb267`, following `8223c96542`. The prior storage checkpoint
passed 359 tests, 1,415 assertions, workspace typechecking, and browser/native
persistence checks. Those results do not prove this unbuilt page model.
The shared worktree contains unrelated auth, inference, recorder, native-close,
and documentation changes. Inspect status and reconcile their current owners
before editing; stage only this task's changes.

| Current caller | Observed behavior | Target responsibility |
| --- | --- | --- |
| `packages/app-shell/src/boot-screens/app-boot.svelte` | `destination`, `observe`, `{#key view.account}`, and transition generations replace sessions | Capture once; own one deliberate departure |
| `apps/honeycrisp/src/routes/components/NotesSession.svelte` | Opens Account App; blurs editor, unmounts consumers, then closes | Page retains this producer-before-document ordering |
| `apps/vocab/src/routes/components/ConversationsSession.svelte` | Opens Account App; closes dictation/chat and document | Capture once; preserve producer cleanup |
| `apps/whispering/src/routes/(app)/_components/RecordingsSession.svelte` | Opens local or Account App; coordinates recording and UI lifetime | Capture once; preserve active-recording refusal and recovery |
| `packages/app-shell/src/account-popover/account-popover.svelte` | Calls `auth.signOut()` directly | Request deliberate departure before auth mutation |
| `packages/auth/src/create-session-auth.ts` | `signOut()` retires synchronously | Called after intentional close; involuntary retirement remains immediate |
| `packages/auth/src/desktop-broker-auth.ts` | Publishes signed-out before host sign-out request | Let host close barrier run before voluntary retirement |
| `apps/epicenter/src/desktop-auth-authority.ts` | Dirty implementation closes application windows before sign-out/relaunch | Reconcile and preserve host-wide ordering |

Current call sites, verified in source:

```ts
// NotesSession.svelte and ConversationsSession.svelte
const app = epicenter.openAccount(account);

// RecordingsSession.svelte
const openedApp = account === null ? epicenter.openLocal() : epicenter.openAccount(account);
```

Their target translation keeps these construction-time captures but moves their
lifetime from a replaceable keyed session to the application page. Each call
executes once per application document. No new public constructor signature is
prescribed. `createEpicenter()` is currently an inert composition factory, not a
memoized live App; calling an opener twice creates two owners.

## Target shape

```text
application bootstrap outside callback imports
  -> capture local or Account selection once
  -> construct one concrete App
  -> ready/loading/error
  -> render editor, search, and other consumers of that same App
  -> one deliberate departure
       quiesce UI -> await App.close -> commit selection -> hard navigate
```

| Value or invariant | Owner |
| --- | --- |
| Primary library for this document | Application bootstrap |
| Buffered edits, dictation/chat producers, UI registrations | Application UI, stopped before document close |
| Readiness, admission, durable drain, resource close | Existing document |
| Captured account transport and credential refusal | Auth Account |
| Physical SQL release and library exclusion | Existing platform/storage owners |
| All-window account/server replacement | Desktop host |

The primary App can be imported as a concrete singleton within an isolated
application module graph. First prove callback and auxiliary routes cannot
reach the opening import. Do not add a mutable `current` handle or forwarding
facade to accommodate root imports. Move imports to the application boundary.
Normal routes within the same application keep sharing its App.

## Execution checkpoints

### 1. Prove Honeycrisp departure end to end

- [ ] Read current auth and native-close diffs and applicable local instructions.
  Reconcile active work; do not overwrite unrelated changes.
- [ ] Capture one Account outside the callback's module graph. Preserve opening,
  loading, errors, and close during delayed acquisition.
- [ ] Build one departure action around existing producer cleanup and App.close.
  Route browser sign-out, server selection, and sign-in redirect from a live
  app through it before they mutate auth or navigate.
- [ ] Make repeated requests share the chosen departure. A later click cannot
  replace its destination. If a reversible preflight refuses, allow retry after
  the cause is resolved; do not reopen a document whose close has begun.
- [ ] Preserve same-owner credential refresh/refusal. Involuntary retirement
  immediately loses network access, then closes locally without opening a new
  library in the same page.
- [ ] Prove a final buffered edit survives departure and reopening its original
  library. Prove failed close prevents auth mutation and navigation.
- [ ] Independently review this complete path before generalizing its shape.

Connection choices may be displayed while the App remains open; choosing or
cancelling alone does not mutate identity. Once a departure has closed the App,
returning from failed/cancelled authentication starts a fresh page. Preserve
useful errors without adding a reusable session manager. Enumerate existing
redirect and connection callers before changing their shared auth contract.

### 2. Integrate the remaining apps and desktop owner

- [ ] Apply fixed ownership to Vocab and Whispering. Preserve local Whispering
  startup; do not add signed-out local mode to apps that do not offer it.
- [ ] Keep inference, dictation, query work, playback, and transfers bound to the
  captured App/Account. Explicit source-library imports remain possible and
  are drained as owned work; they never replace the primary App.
- [ ] Reconcile the desktop broker and authority so voluntary sign-out cannot
  retire the child capability before all affected windows acknowledge close.
- [ ] Exercise native recording refusal, control availability, reload recovery,
  and host replacement failure. Page reload alone must never count as capture
  shutdown or a successful close acknowledgment.
- [ ] Prove singleton import isolation for callback and auxiliary routes, plus
  normal within-library SPA navigation.

### 3. Switch all callers and verify

- [ ] Stop importing reactive replacement-session paths. Keep displaced files
  temporarily unused until verification passes; expose no compatibility mode.
- [ ] Run affected auth/app/storage/UI tests, full-workspace typechecking, and
  real Chromium/WebKit departure checks. Run native all-window close checks.
- [ ] Request independent adversarial review against the cumulative diff and
  accepted invariant. Supply raw code and observed evidence, not just a summary.

### 4. Delete displaced machinery and reconcile guidance

- [ ] Delete reactive `destination`/`observe` session selection, keyed account
  replacement, transition generations, and in-page session reopening.
- [ ] Inline `*Session.svelte` compartments where their remaining ownership fits
  the page. Keep cleanup that stops actual producers. Reassess the inert opener
  composition only against its actual consumers; avoid a new facade.
- [ ] Delete obsolete replacement tests and docs. Preserve storage isolation,
  distinct-library coexistence, retained-handle rejection, and close tests.
- [ ] Update root/local AGENTS guidance and app READMEs to describe actual fixed
  page behavior once built. Preserve ADR-0350's independent sync/refusal rules.
- [ ] Repeat affected verification after deletion, inspect stale imports, and
  commit coherent task-owned changes. Record evidence against the destination.
- [ ] Delete this spec once its work is complete and index it in spec history.
  Preserve the broader spec until its remaining obligations are resolved.

## Verification that decides completion

| Scenario | Required observation |
| --- | --- |
| Delayed buffered edit, SQL/blob write, or acquisition | Selection/navigation waits for producer and document settlement |
| Failure before or during close | No intentional identity mutation or navigation; no second App; actionable refusal or terminal error |
| Double click and competing departure requests | One chosen destination, one close, at most one navigation |
| Auth selection fails after close | No reopening the old App; a return to the application uses a fresh document |
| Same-owner refresh and recoverable refusal | Same App identity; no reload loop |
| Involuntary retirement | Network access retires immediately; no adoption of another account/local library |
| Callback or auxiliary-route load | No primary data/SQL owner opened through shared imports |
| Within-library navigation | Same concrete App shared by consumers |
| Native server/account replacement | Every required window acknowledges close before host mutation/relaunch; missing/failed acknowledgment refuses |
| Active native recording | Refusal preserves resolving controls; reload recovery finds the correct owner's recording |
| Uncontrolled refresh/crash | Already committed data recovers; no claim that final asynchronous work necessarily drained |

Use disposable browser/native stores. Do not erase real user data to run probes.
Close establishes local durability under its error contract; tests must not
silently turn it into an offline-blocking wait for full remote synchronization.

## Remaining separate work

Whole-library erasure still lacks complete durable inventory, exclusion of
independent blob producers, and host media/capture admission and drain. Keep
removal unavailable. This page change neither solves erasure nor authorizes
new deletion behavior. Immediate cross-tab logout propagation is also not
implemented by this plan; no storage-event observer was found in browser auth.
