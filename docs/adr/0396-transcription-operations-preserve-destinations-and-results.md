# 0396. Transcription operations preserve destinations and results

- **Status:** Proposed
- **Date:** 2026-09-12
- **Amends:** [ADR-0054](0054-an-inference-backend-is-the-metered-gateway-or-a-custom-server.md) at model fallback: a saved model the destination cannot serve is refused; nothing substitutes a default.
- **Unbuilt:** Complete Result propagation through recording, upload, and transcription callers; presentation of partial success and targeted recovery.

## Context

Whispering operations still mix capture ownership, row publication, pipeline
execution, and error presentation. Some outer methods return null, booleans, or
void after handling an error. Callers cannot distinguish completed work from a
failed later step. Other paths already retain useful results: upload preserves
its remote URL in `ReferenceNotSaved`, and transcription returns text alongside
a separate history-write Result.

## Decision

An application operation receives the resources and cancellation scope its work
uses. It captures the selected destination and model before asynchronous input
reads. A changed selection never redirects an admitted operation. Missing or
retired access produces an explicit outcome; no similarly named model or other
provider substitutes for the captured destination.

Network inference uses the bound SDK client. Runtime transcription uses the
narrow native transcriber. Do not introduce an aggregate App connection tree or
a universal connection object with a second transcription API for all providers.
The operation composes the resources without owning their storage or host engine.

Expected operational failures remain Results until a final caller chooses
recovery or presentation. An event handler may return void; a reusable operation
must not swallow its failure to accommodate that handler. Intentional no-ops and
cancellation are named outcomes where the caller must distinguish them. An old
push-to-talk release can affect only the capture that its press started.

Account-gateway HTTP 402 may become the product's insufficient-credits outcome.
A custom endpoint's 402 is its own refusal. Keep hosted billing policy in the
hosted API and product presentation; native transcription is not a billing owner.

Operations retain completed work when a later step fails:

| Completed work | Later failure or departure | Retained outcome |
| --- | --- | --- |
| Local audio publication | Recording-row creation | Blob ID and relevant capture metadata |
| Remote upload | Saving the remote reference | Remote URL |
| Transcription | Saving history | Usable text and the history failure |

Retirement prevents publication through a departed owner. It does not turn a
successful byte publication into `NoActiveRecording` or an uninformative null.
Ordinary `RecordingCreationError.RowCreateFailed` already retains `audioBlobId`;
the retirement branches need the same fidelity.

Retry the failed step. A saved remote URL must not trigger an automatic duplicate
upload merely because the row update failed. Retaining a URL in an error is not
a recovery UI. A final caller must consume that distinction and provide any
recovery it claims. These returned receipts exist only while the caller can receive them. Actual
document destruction can leave saved bytes or remote objects without a published
row. A receipt returned in memory is not a durable recovery queue and does not
promise discoverability after restart.

One user action has one error-presentation owner. Simple boundaries can use
`toastOnError(result, title)`, which returns the original Result. Product notices,
logging, OS notifications, and recovery actions stay explicit at the boundary.
Deliberate departure normally presents no error. No generic action runner owns
retries, navigation, state, and callbacks on behalf of all workflows.

Resource opening and closing retain rejecting Promise contracts. Invalid handle
use can throw. Unexpected defects reach a framework or crash boundary; do not
relabel every thrown exception as a retryable operation failure.

## Consequences

Recording workflows retain pending state, capture identity, and temporary cleanup.
Moving presentation does not move those responsibilities into buttons. Operations
become composable because their caller can inspect both failure and completed work.
History remains ordinary recording-row data, with no separate history resource.

## Considered alternatives

- A universal `Connection.transcribe` and `connectionFor(app, selection)`: preserves
  an aggregate connection surface and duplicates the network SDK contract.
- Internal reporting followed by null or void: erases information needed by the
  next workflow or presentation boundary.
- Atomic blob, row, and upload transactions: introduces coordination across
  independent native files, local documents, and remote services.
- Generic durable job recovery: a separate product promise, not a prerequisite
  for preserving the result of the current operation.

## Verification

Trace actual buttons, command dispatch, push-to-talk, and layout consumers.
Cover completed local publication followed by departure, ordinary row failure,
remote URL preservation with targeted retry, failed history with usable text,
retranscription failure retaining prior text, and delayed release after another
capture starts. Test one presentation owner through real entrypoints.
