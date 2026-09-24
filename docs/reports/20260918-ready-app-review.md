# Ready App implementation review

The page owns opening. `await openApp(definition, { account?, runtime? })`
returns a ready App. Failed opening or closure requires page teardown.

This completes the execution described in
[the handoff](20260918-ready-app-handoff.md), against task-start HEAD
`e3a4b70e11`. The unrelated `20260918-integration-review.md` was left untouched
and unstaged. Its SHA-256 remained
`889faf6ef26e71f2213fca102ec034b5194e27ad3803e78cf58dc789e05cbc7f`.

## Review evidence

The cumulative review traced these files and their changed callers and tests:

```text
packages/
|-- app/
|   |-- README.md, ARCHITECTURE.md
|   |-- src/
|   |   |-- open.ts, runtime.ts, testing.ts, index.test-d.ts
|   |   |-- ai.ts, ai-connections.ts, ai-connections.epicenter-host.ts
|   |   |-- recorder.ts, recording/browser.ts
|   |   |-- platform/{default,browser,epicenter-host}.ts
|   |   |-- data/store/{store,browser,idb-updates}.ts
|   |   `-- App, runtime, scope, recording, blob and import-boundary tests
|   |-- evidence/data/{library-ownership,browser/durable-store}/
|   `-- scripts/{browser-smoke.ts,shared-ai-catalog.native.mjs,shared-ai-catalog-native/}
|-- app-shell/
|   |-- src/boot-screens/{departure.ts,departure.test.ts,app-boot.svelte,cannot-open-screen.svelte}
|   |-- src/{inference-selections.ts,inference-picker/connections.test.ts}
|   `-- smoke/{app-boot/,app-boot.browser.mjs}
|-- device/src/{owner,library-claim}.ts
`-- blobs/src/app.ts
apps/
|-- honeycrisp/{README.md,src/lib/application.ts,src/routes/+page.svelte,scripts/library*.ts}
|-- whispering/
|   |-- ARCHITECTURE.md
|   |-- src/lib/{application.ts,bootstrap.ts,application.test.ts,bootstrap-failure.test.ts}
|   |-- src/lib/{operations/,whispering/app.test.ts}
|   `-- src/routes/(app)/+layout.svelte
|-- vocab/src/{lib/application.ts,routes/+page.svelte}
|-- local-mail/ui/{src/lib/,src/routes/+page.svelte,evidence/browser/}
|-- skills/src/lib/application.ts
`-- epicenter/{src/sidecar-runtime.test.ts,src-tauri/src/lib.rs}
docs/{CONTEXT.md,adr/0408-*.md,adr/0410-*.md}
```

## Ownership decisions

| Invariant | Owner |
| --- | --- |
| No partial App escapes opening | `openApp` awaits admission and hydration before publishing |
| One writer per app/account namespace | Runtime admission; App releases only after safe cleanup |
| Returned backing is disposed even if hydration throws | Store receives the backing without a spread or wrapper |
| Thrown acquisition cannot prove release | App retains the claim, including late acquisition failure |
| Catalog construction failure closes its acquired catalog | App registers rollback before transferring cleanup to AI |
| Admitted physical operations drain | SQL, blobs, recording, secrets, and AI service owners |
| Close has one terminal outcome | App caches the close promise permanently |
| Auth mutation follows successful closure | Departure observes retirement through page cleanup, then calls App.close directly |
| Failed opening cannot be overwritten by an in-flight departure | Departure's state publisher preserves the terminal opening failure |

Removed public `App.ready`, `canRetryClose`, `libraryReplaced`, readiness flags,
partial capability slots, and same-page close recovery. `App<T>` derives from
the awaited factory. Account remains uniformly optional. Memory and production
use the same opener and complete runtime contract. Internal store readiness and
retirement machinery remain; this change does not redesign non-App engines.

The backing handoff now avoids the old `heldBackings` set and disposal wrapper.
Focused tests prove that a throwing `loaded` getter disposes once and permits
reopening after safe rollback. Failed rollback retains admission. AI subscription
construction failure has the same safe-release and retention coverage.

Departure owns the exact call to App.close. Its optional `beforeClose` callback
closes page-owned resources while retirement observation remains active. There
is no await between removing that observer and App's synchronous revocation.
The prior callback-shaped closure could await before actually closing App,
which let an external retirement incorrectly permit authentication mutation.

Honeycrisp and Whispering close a ready App before rejecting an unavailable
saved library. Their failure screens retain the library selector. Selection
writes a preference and navigates to a fresh document; failed opening still
cannot authorize an auth action. Choosing Personal while signed out closes
Local and opens the existing connection page.

## Independent review

Claude reviewed the stable checkout through the read-only `consult-claude`
launcher, session `03ef9283-e311-43f2-99a9-0986dc8e93ea`. The reported review
model was `claude-fable-5-1`; both turns completed without permission denials.
An independent Codex verification pass investigated the picker baseline, native
shutdown ordering, consumer typechecks, and browser/native admission evidence.

Accepted Claude's backing-ownership collapse, catalog rollback finding, and
unavailable-library cleanup finding. An executable probe contradicted its first
assessment of departure: retirement during an awaited page cleanup did permit
an auth action. After direct App closure replaced that callback boundary, the
follow-up agreed and found no remaining correctness blockers in the modified
ownership, transfer, or page logic.

Retained `AggregateError` for opening plus cleanup failure. Its `cause` preserves
the opening failure and its errors expose unsafe cleanup; logging is not the
only evidence channel. Rejected allowing auth changes merely because opening
rejected: rejection does not prove rollback succeeded.

The final local pass preserved opening failure across preflight and cleanup
races, verified selection disposal is idempotent, made cleanup log wording
neutral, and restored recorder-cancellation failure coverage. Tests retain
transaction rollback, flush/drain, duplicate refusal, and retired-handle checks.

## Verification

All commands ran locally with Bun. No deployment or remote administration ran.

| Check | Result |
| --- | --- |
| App, app-shell, and affected application unit suites | 854 tests passed across 72 files |
| App TypeScript | All seven projects passed |
| App-shell, Honeycrisp, Vocab, Whispering, Skills, Local Mail | Typechecks passed, including configured browser/host projects and Honeycrisp script checks |
| Honeycrisp production build | Passed |
| Chromium and WebKit AppBoot | Real memory App: loading, rejected opening, preflight refusal, producer/commit drains, connection navigation and reload passed |
| Chromium and WebKit admission | 50 close/reopens, 50 reloads, duplicate refusal, safe rollback, failed-cleanup retention, blocked-acquisition teardown and memory isolation passed |
| Honeycrisp browser journey | Personal isolation, Shared convergence and replacement, failed invalidation, explicit reload recovery, Local isolation, outage reopen and close-before-switch passed |
| Browser recording smoke | Capture, stop, cancellation, offline playback and persisted reopen passed |
| Native SQL and AI acceptance | Physical SQL rollback and TEMP-table disappearance after both location.reload and window destruction passed; catalog/keychain and inference cancellation assertions passed |
| Host sidecar tests | 25 passed, including rejection of SQL close after protocol EOF |
| Repository doc hygiene | 56 existing ADR-status findings remain; the task-start snapshot reproduces all 56 plus the former Proposed ADR-0410 finding |
| Formatting and diff hygiene | Targeted Biome formatting and git diff --check passed |

The five inference-picker failures reproduced in an isolated copy of the
unchanged HEAD source and fixture: six passed, five failed. Supplying the
fixture's intended `configuredFetch` produced 11 passes. That fixture repair
is separate from the lifetime implementation.

Native result retained locally at:
`/private/var/folders/qx/9462vg517cvdtpjr4tt32_200000gn/T/shared-ai-catalog-native-giV0V1/result.json`.

## Limits

Whole-host shutdown still logs a late SQLite dispatcher cleanup failure.
Rust stops and joins its SQLite worker before Bun requests closure after native
protocol EOF. The window and reload assertions prove physical connection
teardown independently. This run does not prove SQL state after whole-host
shutdown, and the warning is not reported as successful late cleanup.

The optional Whispering native audio workflow was not run. Browser recording
and native catalog/SQL fixtures cover the affected runtime boundaries. Opening
can remain pending while an acquisition does not settle; page teardown ends
that attempt. Reload does not prove unsaved changes survived.
