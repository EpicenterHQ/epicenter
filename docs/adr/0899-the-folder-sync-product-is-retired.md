# 0899. The folder sync product is retired

- **Status:** Accepted (2026-11-13)
- **Date:** 2026-11-13
- **Amends:** [ADR-0840](0840-epicenter-is-where-one-persons-software-lives-and-the-folder-sync-product-waits.md) at "the folder sync product waits": it does not wait; it is retired, and nothing returns to it.
- **Amends:** [ADR-0843](0843-new-code-imports-nothing-from-the-waiting-product-which-leaves-by-deletion.md) at "a tag keeps it": the tag `folder-sync-product` stays as history, not as a way back.
- **Supersedes:** the records from ADR-0500 to ADR-0834 that designed the folder sync product and still said `Accepted` or `Proposed`, each listed in the index as "Superseded by 0899".
- **Relates:** [ADR-0835](0835-records-from-0802-to-0834-agree-on-files-a-ledger-and-git-at-the-edges.md) (the product's register), [ADR-0897](0897-hosted-notes-is-a-product-beside-epicenter-and-waits-for-a-month-of-evidence.md) (hosted Notes, which this does not decide).

## Context

ADR-0840 said the folder sync product "waits": its records stay "as the design
of a product that waits", and returning means "a new record that revives what
it needs from them". ADR-0843 deleted its code and kept it at the tag
`folder-sync-product` "so returning to it is a checkout".

The product is folders in `~/Epicenter` kept the same on every device and with
everyone they are shared with, a server that keeps every version and admits
people, Git at the edges, the Epicenter desktop app's Folders window, and web
and phone apps that open folders. Its records run from about ADR-0500 to
ADR-0839.

Asked on 2026-11-13 whether to return to it, the owner answered: retire it.

Waiting left those records saying `Accepted` and `Proposed`. ADR-0840
superseded 0835 to 0839 by link, but every other record of the product kept
its status, and the README says a record that is wrong and still says
`Accepted` will be obeyed. Many also cite code that is gone, so
`bun run check:doc-paths` failed on them.

## Decision

**The folder sync product is retired.** Nothing waits to be revived. A later
product that needs sync, sharing, or a server decides it from its own
evidence, and may read these records and the tag as history.

**Every record that designed it is superseded by this one.** Its status reads
`Superseded`, its header names this record, and its index row reads
"Superseded by 0899". A record from that range that still governs current
work keeps its status: Whispering, `@epicenter/ai`, the account and sign-in,
billing, and conventions for UI, packages, and code. Where such a record
cited deleted code, it cites the file at the ref where it existed
(`folder-sync-product:apps/epicenter/AGENTS.md`) or repoints to the code that
replaced it.

**The tag stays.** `folder-sync-product` is the product's code as history.
Nothing is maintained on it.

## Considered alternatives

- **A fourth status, `Waits`.** It would keep the product's records distinct
  from withdrawn ones. Rejected with the product: nothing waits.
- **Per-file `doc-path-check: ignore-file` markers.** They silence the path
  check and leave each record saying `Accepted`, which is the staleness the
  README warns about.

## Consequences

- `check:doc-paths` skips a `Superseded` record: its paths were true when it
  was written, and it no longer governs. It checks `Proposed` and `Accepted`
  records, which must cite code that exists or a file at a named ref.
- Records before ADR-0500 that belong to earlier directions were not swept by
  this record; one that cites a deleted file now cites it at its ref.
- ADR-0897 is unaffected: hosted Notes is a product beside Epicenter, and if
  it is built it borrows from the tag as history.
