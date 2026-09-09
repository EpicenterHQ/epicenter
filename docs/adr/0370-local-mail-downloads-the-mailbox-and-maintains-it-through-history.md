# 0370. Local Mail downloads the mailbox and maintains it through history

- **Status:** Proposed
- **Date:** 2026-09-08
- **Amends:** [ADR-0368](0368-local-mail-preserves-known-cache-schemas-during-upgrades.md), cursor preservation when the downloaded scope changes.

## Context

The intended use is years of offline mail, daily reconnection, and minimal
repeated network work. A larger first download is acceptable. Date-range
selection would introduce coverage and overlap rules without serving this use.

## Decision

Receive the whole mailbox, including Spam and Trash, then maintain it with
Gmail history. Keep receiving Gmail facts separate from delivering durable local
label intentions. Both run under the existing per-account reconciliation owner.

Commit completed download pages so they become usable immediately. Capture a
history baseline before enumeration. When enumeration completes, sweep absent
rows and persist the baseline, then replay history before reporting success.
Persist message changes and their history cursor atomically. Only successful
history application records the successful-sync time.

Use any saved cursor until Gmail rejects it as expired. Remove calendar-based
full scans and their last-full-pull timestamp. History label events apply their
documented deltas; mutation responses still replace the full returned label set.

Cache v3 preserves downloaded rows and durable intentions but invalidates the
older, smaller-scope cursor once. This forces a new baseline that includes old
Spam/Trash and repairs any labels lost by the former history interpretation.
This is a bounded exception to ADR-0368's cursor-preservation rule.

## Consequences

The initial download can be large. Separate attachment payloads remain outside
the download. Completed pages survive interruption; enumeration restarts from
page one if it did not finish. A failure after enumeration resumes history from
the saved baseline. Expiry during catchup reports failure rather than looping
through unlimited rebuilds.

Local UI queries refresh during synchronization without adding Gmail requests
or a progress-event API. Credentials remain independent of cached mail, so a
browser reload can require reconnection while downloaded mail remains readable.

## Considered alternatives

Date ranges require a separate coverage model. A bounded recent-mail cache
loses offline access to older mail. Repeated full scans spend network work that
Gmail's change feed avoids. A persistent download task system could resume
unfinished enumeration, but introduces durable progress beyond the current
completed-enumeration checkpoint; it is deferred until measured interruptions
justify that machinery.
