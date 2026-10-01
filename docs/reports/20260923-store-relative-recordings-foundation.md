# Store-relative recording foundation

Date: 2026-09-23

This session changed documentation only. ADR-0428 and ADR-0429 are Accepted,
with explicit Unbuilt fields. ADR foundation commit: `8e02241510`.
No production implementation, remote push, deployment, or data migration occurred.

Start implementation from the
[handoff](../../specs/20260923T012158-store-relative-recordings.handoff.md) and
[execution plan](../../specs/20260923T012158-store-relative-recordings.md).
Those planning files are temporary and should be deleted when the work is done.

## Review adjudication

Two fresh read-only Codex reviewers independently reviewed each checkpoint.
They received the same artifacts with different starting questions; findings
were withheld from the other reviewer until both initial verdicts arrived.
All four retained the store-relative model. Full file inventories and verdicts
were returned in the task's review messages.

At the ADR checkpoint, both reviewers requested precise local durability and
detached-content guarantees. Accepted: flush alone is insufficient; inspect
persistence status, retain the known row ID, and reconstruct fresh content from
values captured before transfer. The ADR also now explicitly uses the product
departure fence and gates reader cutover on existing-data disposition.

At the handoff checkpoint, accepted these grounded corrections:

- Move Local pipeline/transcription consumers with Local capture. Prepare
  Personal readers and controlling-worker presentation before exposing the new
  Personal writer. No compatibility resolver is needed for wave ordering.
- Retain recovery receipts in the document-lifetime layout owner and provide
  visible retry after the initiating component is destroyed. Returning an error
  object from an operation is insufficient if its UI discards that object.
- Preserve captured account prompt/dictionary inputs during delayed acquisition.
  Save Local immediately; dependent transcription waits or reports unavailability.
- Confirm transcript/polished-text durability and retain computed text for retry
  without another inference request. This does not require ADR-0425 conversion.
- Include older clients and pending offline writes in the data cutover gate.
  A one-time inventory cannot establish that legacy addresses will not return.

Local final inspection also corrected an API sketch: Personal has no `stat`.
Availability uses each containing store's actual capabilities; the plan must not
invent method symmetry. The reviewed changes adjust execution dependencies and
acceptance criteria, not the accepted product model. No additional review pair
was commissioned merely to obtain agreement.

The retained cost is bounded in-memory recovery and product field mapping.
Dropping recovery would strand known saved bytes or force duplicate transfers.
A generic reference envelope, association table, and durable queue were rejected
because they recreate work the independent-record model removes.

## Verification and limits

Task-start implementation baseline: `c9728ab926b92d3ef6566e198681545520b691bd`.

- Focused toolkit tests: 17 passed, 79 assertions.
- Focused Whispering recording/upload tests: 15 passed, 66 assertions.
- These 32 tests validate the current old model, not the proposed replacement.
- New ADR/spec local links resolve. Staged whitespace checks pass.
- Document hygiene reports 61 issues; its complete output matches the captured
  pre-edit baseline, including after new ADRs/specs were staged.
- No full typecheck, replacement runtime test, physical microphone check, or
  cross-device product acceptance was performed in this documentation session.

Existing-data inventory and disposition remain unresolved. Isolated
implementation is possible; enabling replacement readers over affected stores
requires the explicit disposition described in the plan. No existing data was
rewritten or deleted. Unrelated dirty and untracked workspace files were left alone.
