# 0378. Local Mail saves message rules as triage views

- **Status:** Proposed
- **Date:** 2026-09-08
- **Revised:** 2026-09-24, after the saved-query report surface revealed that the useful result is an actionable mail view.
- **Implemented portion:** Local Mail synchronizes named `savedQueries` rows and runs bounded, read-only SQL against one downloaded Gmail cache. The current results are separate, non-actionable tables.
- **Unbuilt:** Saved message-rule contract, view tabs in the mailbox, effective-label evaluation before paging, next-message selection after triage, and agent-assisted rule discovery.

## Context

Local Mail downloads each Gmail account into a device-local SQLite file. Its
mail list overlays pending label choices on Gmail's cached labels before
filtering and paging, so a locally trashed or archived message leaves the Inbox
before Gmail confirms the change. The current `savedQueries` table instead
stores arbitrary SQL. A person must open a separate screen, press Run, and read
a transient result table that cannot be used to triage mail.

The desired use is different: ask an agent to inspect downloaded mail for
recurring patterns, choose a useful rule, and return to that named set of
messages for manual triage. The saved object must select messages rather than
preserve a report layout or the agent's past judgments.

## Decision

**A saved view is a named, deterministic rule for selecting messages in the
current Gmail account's Inbox.** Local Mail stores `name` and `where` fields in
the Personal `savedViews` table; `where` is the SQL predicate, without a
`WHERE` keyword or caller-supplied `SELECT`. The definition synchronizes;
downloaded messages, query results, provider credentials, and pending Gmail
actions do not. A definition is account-independent, so a view may match
different mail or be unusable on another connected account; Local Mail shows a
rule error rather than hiding the view or guessing another meaning.

Local Mail owns the `messages` projection, selected summary columns, effective
Inbox and Trash scope, newest-first ordering, and page limit. A saved predicate
may read downloaded `messages` and `labels` facts. It cannot supply the result
columns, ordering, pagination, database name, read policy, or a Gmail action.
Local Mail validates `where` as one SQL expression that cannot escape the
fixed statement, composes it with its effective Inbox and Trash scope **before**
ordering and paging, and executes the whole statement through the bounded
read-only query operation. It does not interpolate the predicate into trusted
unrestricted SQLite reads or filter a capped arbitrary result afterward.
The app-owned Inbox and Trash scope uses effective pending labels. A predicate
that itself reads cached `label_ids` may lag a pending change to another label
until Gmail confirms it and the cache updates; the view must not claim those
clauses are effective-label reads.

The mailbox shows the built-in Inbox and named saved views as horizontally
scrollable tabs above its existing message list. Selecting a tab evaluates its
rule against the selected Gmail account and displays matching messages through
the same detail, keyboard, triage, and Undo path as Inbox. A successful Archive
or Move to Trash removes the message from the view and selects the next
matching neighbor, or the previous neighbor at the end. A failed action leaves
the selection in place. The agent never creates a Gmail action by selecting or
editing a view. Opening a view executes a local read; it does not call an AI
model.

An agent may use bounded exploratory reads to propose a rule. Its proposal is
not saved or applied until the person inspects the matches and explicitly
saves it. Once saved, the rule evaluates new downloaded mail without another
agent call or a per-message classification record. A local editor may also
create or repair a view; an invalid synchronized definition remains visible
with an error. Saving retains the existing persistence and remote-edit
protections wherever an unsaved editor remains.

This record does not choose an agent runtime or authorize sending mailbox
content to a remote model. A remote agent that receives inspected mail would
change ADR-0319's current device-local disclosure promise and needs an
explicit, user-visible boundary before that integration ships. A saved
predicate can itself contain sender addresses or other mail-derived literals;
the person can inspect it before choosing to synchronize that authored rule.

## Consequences

The `Saved queries` screen's arbitrary result grid, explicit report Run state,
and separate mailbox-versus-report navigation retire. The bounded arbitrary
SQL operation remains available for exploration; sender counts and other
aggregates can inform a proposed rule without becoming a second saved-report
product. No classification table, background reclassification job, or
materialized view membership is introduced.

The Inbox scope makes each tab a review queue: archiving or trashing a match
removes it, even if its sender or subject still satisfies the saved predicate.
This does not promise all-mail reporting or semantic judgments about every new
message. A rule can approximate "low priority" through observable patterns,
and the person reviews the matches before acting.

The current arbitrary `savedQueries` rows and report UI are an implemented
prototype, not the target contract. The cutover removes that surface and
introduces `savedViews`; it does not reinterpret arbitrary report SQL as an
actionable message identity merely because a result has an `id` column.

## Considered alternatives

- Keep arbitrary saved reports and add message views beside them: retains two
  saved SQL products, two navigation paths, and a question about which results
  can act on mail when the requested daily workflow needs one.
- Store an AI category on every message: requires classification on arrival,
  retries, stale-result policy, and a new local corpus to maintain. A saved
  deterministic rule needs none of those to match later mail.
- Run a saved query to obtain IDs and filter its capped results in the UI:
  loses matches beyond the SQL result cap and applies pending triage after
  paging, producing stale or falsely short lists.
- Forbid every predicate over cached Gmail labels: requires a new
  column-level SQL policy and prevents useful category or user-label views.
  The fixed effective Inbox and Trash scope keeps the review queue's removal
  behavior immediate while other label predicates report cached facts.
