# 0915. Serve owns a page's runs and a file input is a temporary upload

- **Status:** Accepted (2026-11-15)
- **Amended by:** [ADR-0917](0917-a-pages-calls-are-serve-owned-runs-and-observing-is-not-cancelling.md)
- **Date:** 2026-11-15
- **Relates:** [ADR-0879](0879-an-action-may-yield-values-while-it-runs-and-only-its-return-is-the-answer.md), [ADR-0883](0883-an-epicenter-is-its-git-repositories-and-serve-and-its-host-keeps-runs-and-guards-them.md), [ADR-0907](0907-private-input-is-a-whole-call-handling-policy.md), [ADR-0914](0914-action-errors-share-one-contract-and-the-envelope-records-execution.md).

## Context

A page's long action with a file must outlive the tab. An ordinary call ties
its observer to execution. Repeating that call after losing its answer could
repeat effects. Uploads also need a lifetime separate from app records.

## Decision

Serve owns admitted runs in one host process. Every page call uses one run
lifecycle. `runs.start` writes a per-id receipt under `epicenter.run:<id>`
before any request. The client uploads files sequentially by raw PUT and POSTs
admission once with a 20-second header timeout. An ambiguous answer is observed
by id, never resent. A definitive refusal removes the receipt. Attaching
observes without admitting. Events replay by cursor and reconnect with backoff;
a 404 is unknown and retains the receipt.

A top-level `field.file` accepts MIME restrictions and a positive integer
`maxBytes` up to 15 MiB. Its wire value is an opaque host-issued reference.
The action receives `UploadedFile` methods valid only while it runs. CLI, MCP, routines, nested schemas, and collections refuse file inputs.
Ordinary page calls and `runs.start` accept file inputs. Persistent attachments remain undecided.

The runtime defaults to `~/.local/state/epicenter/prototype-runs/<hash>`, using the first
16 hex characters of SHA-256 of the root real path. `EPICENTER_RUNTIME_DIR`
may override it outside the Epicenter and every app. Storage is owner-only;
Time Machine exclusion is best effort. The existing Host, Origin, and tunnel
guards cover uploads, admission, state, events, and cancellation.

Limits are 15 MiB/file, 1 MiB admission JSON, 256 KiB/yield, 4 MiB/log with
1 KiB terminal reserve, 512 MiB admission threshold including SQLite and uploads, 32 active runs,
and 64 observers. A finish with `returned` deletes
input bytes. Other outcomes keep them until the 24-hour terminal TTL.
Orphan uploads and parts expire after one hour. Cleanup checks every ten
minutes and under admission pressure.

Recovery marks non-terminal records `interrupted` at startup or on read;
it never reruns them. Observer loss leaves execution running. Explicit cancel
records a request and aborts the cooperative action signal. Errors and
cancellation establish no rollback or safe repetition.

Private-input admission persists neither JSON input values nor a JSON input
digest. A digest could confirm guesses about input otherwise never written
here. Duplicate admission matches the action alone. Ordinary admission compares
validated-input digests. Uploaded file metadata, hashes, and bytes follow the
ordinary retention rules. Actions still own their output and may emit private
data if written to do so.

## Consequences

- Files are temporary inputs, not persistent attachments or app data.
- One process must own each runtime directory; multiple hosts are unsupported.
- Run controls live outside the action tree: `runs.start(action, input)`,
  `runs.attach(action, id)`, and `runs.pending(action)`. Existing app action
  names remain callable at every depth, including Flights `daily.start` and
  the Vocab and Zhongwen `practice.start` actions.
- Retention and browser journals are bounded recovery aids. Their loss does not
  authorize automatic repetition of an action.

## Considered alternatives

- **Multipart through the ordinary call.** Keeps execution tied to observation
  and leaves ambiguous retries without a durable id.
- **Commit uploads under `data/`.** Makes temporary inputs persistent records
  and sends their bytes into app history and backups.
- **Rerun after recovery.** Can repeat effects that happened before the host
  stopped. Preserve uncertainty and require an explicit new run.

The client imports the `epicenter.runs.prototype.v1` journal into per-id
receipts. The default runtime path retains its prototype name.
