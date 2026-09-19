# Browser verification

Playwright Test runs three stateful journeys in Chromium and WebKit. The tests
use synthetic accounts in fresh browser contexts and exercise production UI,
storage, and callback code. They require no Infisical login or Gmail credentials.

From the repository root, install the suite's pinned browsers once, then run:

```sh
bun run --cwd apps/local-mail/ui test:browser:install
bun run --cwd apps/local-mail test:browser
```

The command builds the application and both fixture pages before running six
tests. For a focused run:

```sh
bun run --cwd apps/local-mail test:browser --project=webkit route-smoke
bun run --cwd apps/local-mail test:browser --project=chromium browser-workflow
bun run --cwd apps/local-mail test:browser --project=chromium gmail-authorization
```

Add `--headed` to watch a journey in a real browser:

```sh
bun run --cwd apps/local-mail test:browser --project=chromium --headed route-smoke
```

The runner lives in `apps/local-mail/ui/e2e/`; browser fixture sources remain
in `apps/local-mail/ui/evidence/`. The `.e2e.mjs` suffix keeps these journeys out
of Bun's unit-test discovery. Normal UI typechecking includes the browser
fixture sources. Each journey keeps its state across named steps so reloading
actually verifies what the preceding steps persisted.

## What the journeys prove

| Journey | Coverage |
| --- | --- |
| Routes | Actual built SvelteKit callbacks and preload open no primary library; signed-out boot; ready-gated App and SQLite worker opening; draft protection during ordinary query switches; tab and connection navigation; forced retirement without a draft veto; recovery that opens no App; explicit saved-query reopening. |
| Saved queries | Production panel, App, OPFS and restricted SQL; two account caches; offline reopen; write rejection; exact result values; peer conflicts and incompatible rows; IndexedDB quota failure and retry; cancelled account-bound runs. |
| Gmail callbacks | Production PKCE builder and connected route; popup source, origin and path rejection; successful return; cancellation and closed windows; standalone callbacks; automation's popup-permission limitations. |

The shared startup fixture uses the production download encoder to echo a new
library's seed. It does not simulate server arbitration or live synchronization.
Peer changes use separate real Apps and the production remote-update boundary.
Quota faults occur in the actual IndexedDB transaction API.

Route and query journeys use fresh persistent profiles per test attempt, then
clear their synthetic origin's OPFS before application startup: macOS WebKit
can retain OPFS across different temporary profiles. They never clear it on
reload within that profile. This tests document reopening, not browser-process
restart or abrupt crash recovery. Offline query checks disable the synthetic
account transport; the browser can still load application assets.

The cancellation case observes a bounded interval for late results and then
runs another query. It does not establish when the underlying worker stops.
Both automated engines may allow popups without user activation; their results
do not establish popup permission in an ordinary browser profile.

## Diagnosis and ownership

The runner retains traces and screenshots on failure, with named steps in its
HTML report. JSON attachments retain route build metadata, tab states, and
workflow observations. Reports live in `apps/local-mail/ui/playwright-report/`;
failure artifacts live in `apps/local-mail/ui/test-results/`.

`playwright.config.mjs` owns projects, timeouts and server startup. A Bun child
process builds and serves immutable outputs on four separate local origins;
Playwright workers do not need Bun globals. Shutdown removes temporary builds,
and test teardown closes contexts and removes their temporary profiles.
The default ports are 41770 through 41773. Set `LOCAL_MAIL_TEST_PORT` to change
the starting port; existing servers are never reused. Keep one worker: concurrent
attempts must not clear or write the same test origin's OPFS.

The Local Mail browsers workflow runs on pull requests and pushes to main,
installs browsers with this package's CLI, and uploads failure artifacts. It has
no path filter because shared packages and build configuration affect these
journeys. Hosted Linux execution must still pass in CI; local WebKit runs use
the local operating system's build.

## Remaining end-to-end evidence

These tests do not establish real Epicenter sign-in, live Gmail download,
history catchup or delivery, native WebView behavior, or keychain reopening.
The next browser journey should drive the real Gmail HTTP client through a
paginated synthetic response, interrupt a download after one page commits,
reopen, and verify that sync resumes from the saved bookmark. Record requests
alongside rendered mail so a repeated full download cannot look like recovery.

A separate manual pass needs a designated Gmail test account and normal popup
permissions. Verify desktop opening and keychain retrieval separately. Choose
the test message and label change before testing delivery: reconciliation can
send pending triage. Existing profiles and mailboxes are outside these tests.
