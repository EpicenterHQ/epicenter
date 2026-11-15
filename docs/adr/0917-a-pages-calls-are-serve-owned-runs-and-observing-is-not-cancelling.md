# 0917. A page's calls are serve-owned runs, and observing is not cancelling

- **Status:** Accepted (2026-11-15)
- **Date:** 2026-11-15
- **Relates:** [ADR-0879](0879-an-action-may-yield-values-while-it-runs-and-only-its-return-is-the-answer.md), [ADR-0907](0907-private-input-is-a-whole-call-handling-policy.md), [ADR-0914](0914-action-errors-share-one-contract-and-the-envelope-records-execution.md), [ADR-0915](0915-serve-owns-a-pages-runs-and-a-file-input-is-a-temporary-upload.md).

## Context

A page can lose its connection after an action has changed files but before it
sees the answer. Repeating the call may repeat those effects. A long action
also needs to continue when a page closes and be observable from another page.
ADR-0915 gave explicit runs durable identities, while an ordinary call still
had a separate execution and observation lifecycle.

## Decision

Every page action call is a serve-owned run. An ordinary awaited call and
`runs.start(action, input)` share one client core, one POST event stream and
parser, one host executor, and one SQLite store. Serve commits acceptance
before responding. A disconnected observer, an aborted observer signal, or a
throwing yield callback stops observation only. `run.cancel()` records a
cancellation request and aborts the cooperative action signal. The client never resends admission, and serve never reruns an interrupted action.

An ordinary call keeps its run id in memory. `runs.start` also saves a per-id
localStorage receipt before sending; `run.isRemembered()` tells the page
whether that receipt exists. Storage failure does not prevent a run. An
`Unreachable` or `Stopped` error made by the client includes the run identity,
so the page can attach to the same id. Existing v1 browser receipts and host
run directories are imported idempotently. The retired
`POST /<app>/<action>` executes nothing and returns a reload message.

The runtime remains outside the Epicenter. SQLite uses WAL and
`synchronous=FULL`; each event commits before publication. Payloads are
content-deduplicated and gzip-compressed when smaller. Every accepted run and
published event stays for 24 hours after the run ends. The 512 MiB admission
threshold counts uploads, the database, WAL, and SHM, including in-flight upload
reservations. Admission reserves a 4 MiB serialized event-log allowance per
active run, including a terminal frame. This threshold refuses new work; it
does not cap physical disk usage. Accepted runs can finish above it, and SQLite
metadata and WAL add overhead. The host permits
32 active runs and 64 observers. ADR-0907's private-input policy remains:
input values and their digest are not stored; file metadata and bytes follow
the ordinary upload retention policy.

## Consequences

- A page can observe the same run after a lost response without repeating it.
  A missing id or an interrupted run does not prove which effects occurred.
- Runs and events consume host storage even when nobody observes them. The
  admission threshold, 24-hour retention, and per-run and concurrency limits
  constrain that cost. Tiny updates can add substantial SQLite overhead:
  30,000 numeric yields used about 18 MB in a scratch check. Disk-full errors
  can prevent a terminal commit; the host promises no hard filesystem quota.
- A page must use explicit cancellation for a Stop button and check
  `isRemembered()` before promising recovery after a reload.
- The in-process benchmark uses a temporary Epicenter, eight concurrent page
  calls, a roughly 240 KB chat history, and 20 streams of 500 yields.
  A 51,840-poll run per day on Bun 1.4.3 measured 497 and 509 calls/s across
  its two days, with zero refusals. Yield resume latency had a 0.088 ms median
  and 0.178 ms p95. These measurements describe that workload and machine, not a
  deployment guarantee.

## Considered alternatives

- **Keep a separate ordinary-call executor.** Two lifecycles would differ on
  connection loss, file inputs, and replay, leaving callers to choose before
  they know whether they need recovery.
- **Discard events on acknowledgement.** One observer could erase another
  observer's replay, including a page recovering after a lost response.
- **Split durability by `readOnlyHint`.** A read-only action can still be
  expensive or depend on changing external state. The hint does not decide
  whether its caller needs to recover an answer.
- **Keep a JSON directory per call.** Directory scans and the former 1000-run
  cap make frequent page calls compete with long runs. SQLite indexes terminal
  expiry and deduplicates repeated payloads.
- **Add cancellation tombstones and deadlines.** This could settle races
  before admission, but adds a separate persistent cancellation protocol. It
  is deferred until a caller needs it.
