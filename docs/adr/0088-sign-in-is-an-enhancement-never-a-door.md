# 0088. Sign-in is an enhancement, never a door

- **Status:** Superseded at its title. Sign-in IS a door (ADR-0342, rejected 2026-09-06: an ephemeral signed-out session would lose a person's work silently, so an unauthenticated state blocks interaction). Every application renders a sign-in screen and opens no store while signed out. What survives is cited below.
- **Amended by:** [ADR-0350](0350-a-data-session-is-a-value-the-tree-owns-and-sync-runs-for-the-life-of-the-store.md) at its page-lifetime and reload clauses, which are withdrawn: a session is keyed on the principal and nothing reloads. What still stands and is still cited: one composition shape, the account popover as the only auth surface, and `apps/api/ui` exempt.
- **Date:** 2026-07-01
- **Amended by:** [ADR-0342](0342-sign-in-is-the-door-to-keeping-not-to-using.md) at "No Epicenter workspace app gates behind sign-in", and at the two mechanisms under it that ADR-0336 removed: the signed-out bare IndexedDB document and the Add / Delete / Keep migration. An application without an account works and keeps nothing; signing in is what makes a store durable. The rest of this record stands, including the one every live citation is about: a page lifetime is one auth generation.

## Context

Whispering ships the local-first thesis literally: it boots into a working
device-local workspace, and signing in only adds sync (boot-time doc selection
in `whispering.active.ts`, reload on principal change, a flag-free first-sign-in
migration). Every other workspace app (opensidian, honeycrisp, vocab,
tab-manager) hard-gates its entire UI behind a `SignedOutScreen`, so the
codebase carries two composition shapes ("Shape A" auth-gated `createSession`
lifecycle vs "Shape B" module singleton), two mental models, and a signed-out
panel in the shared account popover that is unreachable in four of five apps.
The gates contradict the product sentence the company is built on: an app you
cannot open without an account is not local-first. The break is
compatibility-free: gated apps never wrote unowned local data, and existing
users boot signed-in from persisted grants, so no migration reader is needed.

## Decision

No Epicenter workspace app gates behind sign-in. Every workspace app boots
into a working local workspace using one composition shape: read persisted
auth once at boot; signed-out attaches the bare IndexedDB doc (database name =
`ydoc.guid`), signed-in attaches principal-scoped storage plus relay sync; a
principal change reloads the page; the first signed-in boot that finds local rows
offers the Add / Delete / Keep migration. The account popover is the only
auth surface. Corollaries: `AuthState` stays three states (no anonymous or
guest identity; the local doc is unowned), sign-out reveals the local doc and
deletes nothing (the explicit "Forget this device" action is the only wipe),
and signed-in-only features degrade with small inline affordances rather than
gating the app. `createSession` no longer owns any workspace lifecycle; it
survives only for auxiliary signed-in-only resources (the vault keyring
session). The `apps/api/ui` dashboard is exempt: it has no workspace and
sign-in is its product.

## Consequences

`SignedOutScreen`, the `(signed-in)` route groups, vocab's `/sign-in`
redirect route, and the Shape A / Shape B split in
the app-composition skill are deleted; one shape is documented, in
`platform-seams` since that skill replaced it. The
boot branch and `reloadOnPrincipalChange` move from Whispering into
`@epicenter/svelte/auth`; the flag-free migration kit moves into
`@epicenter/app-shell`. `AccountPopover.instanceConnect` becomes required,
since every app's popover now renders the signed-out panel. The costs: each
app must define what signed-out means feature by feature (server-dependent
features need inline signed-in affordances), every app inherits the reload
tax on identity change (and the `disabledReason` guard where a reload is
destructive), and a signed-out visitor's data lives in one shared unowned
local doc per browser profile, which is acceptable because sign-in plus
migration is always one click away.
