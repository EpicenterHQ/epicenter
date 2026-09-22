# Independent resource implementation

The package opens resources independently. `openApp`, `AppRuntime`, aggregate
platform bindings, `fromApp`, the lazy App SQL wrapper, and catalog preview
transports have been removed. Product composition remains in product code.
No compatibility facade replaces them.

## Implemented surface

| Subpath | Acquisition |
| --- | --- |
| `@epicenter/app/open` | `openLocal(definition)`, `openPersonal(definition, { account })` |
| `@epicenter/app/blobs` | `openLocalBlobs({ id })`, `openRemoteBlobs({ id, account })` |
| `@epicenter/app/sqlite` | `openSqlite({ id })`, then dynamic `open(name)` and `delete(name)` |
| `@epicenter/app/secrets` | `openSecrets({ id })` |
| `@epicenter/app/recorder` | `createRecorder({ blobs })` |
| `@epicenter/app/ai` | `openEpicenterInference({ account })`, `openRuntimeInference()`, `openEndpointInference({ baseURL, getAuthHeaders? })` |
| `@epicenter/app/ai-connections` | `openLocalConnectionCatalog()`, `openAccountConnectionCatalog({ account })` |

Handles own signals and terminal asynchronous close. Endpoint owners register
work before resolving authentication, fence the destination, suppress ambient SDK
authentication, refuse redirects, omit cookies, and drain requests and bodies.
Runtime absence returns null. Saved native credentials remain broker-owned and
access-version guarded.

LocalBlobs owns admitted recorder publication and transfer participation. The
recorder captures into the supplied destination on both platforms. Remote
`addFrom(localBlobs, id)` carries private source provenance; the native host reads
that source namespace even when the destination has a different same-ID object.

The shared picker receives borrowed inference sources. Unsaved previews own and
close endpoint handles. AppBoot calls a product opener with a startup cancellation
signal. Products close already-acquired resources immediately on cancellation,
close late arrivals, and stop before the next acquisition, including when runtime
inference resolves null.

## Baseline and preservation

The starting status, name-status, untracked list, binary diff, and untracked file
copies are preserved in `/tmp/epicenter-independent-baseline`. The starting App
suite passed 808 tests. It still contained aggregate lifecycle tests; those were
removed or replaced by tests of the independent owners and their actual callers.
The final combined count below is not a like-for-like increase over that baseline.

The captured baseline also contained an invalid unwrapped declaration in
`compile.test.ts` and a browser blob-write error-union inference failure. Both are
fixed, alongside consumer errors from the earlier store split. Final typechecks
listed below pass. Unrelated initial work remains in the checkout. No staging,
commit, reset, deployment, stored-data migration, or ADR status change occurred.

## Reviews and repairs

Three adversarial checkpoints examined boundaries, independent owners, and the
cumulative implementation. The final pair reused existing reviewer tasks because
the available agent-thread limit prevented another fresh pair. Reviewers remained
read-only; their feedback was checked against the live implementation.

Accepted repairs included:

- Remove the second SQL owner and dispatch native close before waiting for pending
  queries. Observe release failure while continuing to drain admitted operations.
- Preserve callback-provided Authorization across the native endpoint relay.
- Roll back catalog hydration/subscription failure and propagate backend retirement.
- Treat cancelled transfer work separately from failed resource cleanup.
- Refuse a deleted saved connection during discovery; never substitute an unsaved
  endpoint from its retained edit form.
- Cancel intermediate product startup, including a delayed absent runtime, rather
  than waiting indefinitely with earlier resources still acquired.

The local post-implementation pass checked close ordering, provenance, credential
resolution, consumer wiring, removed imports, and the documented ownership model.
Concrete product composition and resource-specific admission remain separate.

## Verification

| Check | Result |
| --- | --- |
| App, device, blobs, client, app-shell, native account transport and catalog suites | 909 passed, 0 failed, 3,513 assertions |
| Whispering | 194 passed |
| Honeycrisp | 26 passed |
| Vocab | 51 passed |
| Local Mail UI | 27 passed |
| Actual Whispering signed-out route startup | 1 passed |
| Package typechecks | App (including data/evidence projects), device, blobs, client, app-shell, Svelte passed |
| App typechecks | Whispering browser/native, Honeycrisp, Vocab, Local Mail UI, Skills, Epicenter host passed |
| Synthetic Chromium recording | Capture, metering, decode, offline playback, cancellation, identical bytes after reopen passed |
| Chromium document admission | Duplicate refusal, failed-cleanup exclusion, handoff, 50 replacements and 50 reloads passed |
| Chromium and WebKit SQL | Deletion retirement, physical contention, retry, independent owners, cross-window handoff passed |
| Chromium and WebKit catalogs | Account partitioning, cross-app sharing, retired clients, retained legacy bytes passed |
| Desktop broker browser harness | Hidden keys, key mutation, stale versions, shared updates and unsaved endpoint preview passed |
| Picker browser acceptance | Save races, retirement, hidden credentials, deleted saved entry refusal passed |
| Chromium and WebKit AppBoot | Recovery, departure, startup failure, late acquisition after unmount passed |
| Real macOS WebView endpoint | Callback auth and gateway headers, chat completion, exact multipart bytes, cookie omission, body cancellation passed |
| `git diff --check` | Passed |

The native endpoint run's isolated result is at
`/private/var/folders/qx/9462vg517cvdtpjr4tt32_200000gn/T/shared-ai-catalog-native-36jbbe/result.json`.
Reproduce it with `bun packages/app/scripts/shared-ai-catalog.native.mjs --endpoint-only`.
Native exact-source upload is additionally covered by real loopback host requests
in `apps/epicenter/src/account-transport.test.ts`.

## Limits and deferred product work

The full real WebView saved-catalog run reached the first credential write and
failed because macOS reported: `Platform failure: User interaction is not allowed.`
No keychain permissions were changed. Browser/host tests establish hidden-key and
stale-version behavior, but this run does not establish OS keychain persistence
through real native catalog restart. Re-run the full native catalog harness in a
session that permits its isolated keychain writes.

These checks do not establish physical microphone behavior, native engine model
inference, Windows/Linux behavior, or signed release packaging. The native
endpoint acceptance uses a real WebView and production broker with a controlled
loopback OpenAI-compatible service.

Whispering's existing Local/Personal recording-library choice is preserved.
Signed-in sessions still need Personal for dictionary, instructions, and recipes
regardless of the recording library, and Local for device preferences. Removing
that startup dependency requires a product decision about account settings while
offline. This implementation adds no sharing action, recording destination,
route structure, or audio-sharing behavior. Historical account-local bytes remain
untouched; no migration or fallback reader runs.
