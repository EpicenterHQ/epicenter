# Design the API for Local, Personal, and Shared libraries

The opening API has since been selected and recorded in ADR-0375:
`openLocal()`, `openPersonal(account)`, and `openShared(account)`. Continue from
the [execution spec](20260909T004225-library-ownership-execution.md). This handoff
retains the original design context; its requests to choose an opening API are
historical, not a reason to reopen that decision.

Continue in `/Users/braden/conductor/workspaces/epicenter/yamoussoukro`.
Produce a concrete API design and an execution plan for the library ownership
model recorded in [ADR-0375](../docs/adr/0375-library-ownership-is-local-personal-or-shared-within-one-deployment.md).
Use `adversarial-review` for an independent structural checkpoint. This is a design
pass before production implementation, not permission to resume the previous
URL/token migration or to rewrite the data engine immediately.

## What the user settled

Epicenter Cloud offers Local and Personal application libraries. A self-hosted
deployment offers Local, Personal, and Shared. Self-hosted users sign in as
themselves, keep their own Personal libraries, and can open the deployment's one
Shared library per application. Every admitted user has full read/write access
to Shared, including existing content. There are no organizations, groups,
workspace invitations, per-document permissions, or read-only shared members.
Deployment administration is separate from shared-content access.

The actor is still Alice when Alice opens Shared. Shared is not a user to sign
in as. Applications remain separate: Shared notes and Shared recordings do not
become one schema or automatically expose local-only data. Different servers
remain isolated. Library selection never implies copying or migrating data.

The user wanted a high-level ADR first, then a careful pass over the TypeScript
surface. They explicitly did not want an internal `kind` representation or a
`principalId` rename fixed by the ADR. `openShared()` was an illustration, not an
accepted API or an existing method. Shared is the product term to carry forward;
internal representation is yours to recommend with evidence.

## How the direction changed

The original task executed
`specs/20260908T214916-one-active-account.handoff.md`: one stock client, Cloud
sign-in or a custom URL/operator token, one captured Account, close/restart for
replacement. Implementation paused midway when the user challenged spreading
`auth.method === 'cloud'` through consumers.

The design discussion then considered configured installations, concrete
sign-in composition, and finally named-user self-hosted sessions. The user
added personal libraries alongside one deployment-shared library and confirmed
equal read/write access for all admitted users. The old spec, its handoff, and
the draft runtime-selection decision in ADR-0374 are evidence of prior work,
not instructions to restore the token-only target. Their safety cases remain
valuable; their product and API assumptions need reconciliation after this pass.

One startup composition with a shared Account lifetime was the independent
review's recommendation. It did not establish that two binaries or build-time
profiles are necessary. A configured installation is promising, but the source
of configuration, first-run setup experience, and reconfiguration workflow are
not settled. Neither OAuth/OIDC, Google, nor a database has been selected as the
required self-host authentication implementation.

## Start with the live boundaries

Read repository instructions and the applicable skills. Verify symbols against
code before using ADR descriptions as API facts. The primary entrypoints are:

- `packages/app/src/index.ts`: `Application` exposes `openLocal()` and
  `openAccount(account)`. There is no `openShared()`.
- `packages/principal/src/principal.ts`: `AccountIdentity` carries authority and
  principal; the principal is documented as both authenticated identity and
  partition. Shared libraries require reconsidering that equivalence.
- `packages/auth/src/auth-contract.ts`, `create-session-auth.ts`,
  `hosted-browser-redirect-auth.ts`, and `desktop-broker-auth.ts`: shared lifetime,
  concrete acquisition, and the partially migrated `AuthStartup` contract.
- `packages/server/src/middleware/require-auth.ts`, `routes/session.ts`,
  `store-sync/mount.ts`, and `routes/blobs.ts`: authentication projects the
  principal and resource storage uses it directly.
- `packages/server/src/auth/create-auth.ts`, `session-handoff.ts`, and
  `apps/api/worker/index.ts`: session issuance, deployment composition, and
  hosted-only billing separation.
- `apps/self-host/README.md`, `server.ts`, and `worker/index.ts`: the token-only
  reference being reconsidered. The Worker provides store sync; Bun does not.
- `packages/data/src/store/browser.ts`, `packages/app/src/browser.ts`, and
  `packages/app-shell/src/boot-screens`: local addressing, blob composition,
  application bootstrap, and departure.
- `apps/epicenter/src/desktop-auth-authority.ts` and `ui/Settings.svelte`, plus
  Honeycrisp's application module, auth platform leaves, and root route:
  concrete host and browser consumers.

Follow those callers far enough to cover authentication, library opening,
sync, blobs, local cache ownership, library erasure, and closure. Do not build a
generic permission framework or audit unrelated application features.

## The next useful judgment

Recommend the smallest complete public API that expresses the settled model.
Show concrete callers for Local, Personal, and Shared before choosing types.
Compare separate opening verbs with a single explicit-destination opener only
far enough to make a recommendation. Do not make the user choose from a catalog
of equivalent type encodings.

Identify one owner for each boundary: installation configuration, signed-in
identity, server admission, authorized library destination, local cache address,
and opened App lifetime. Explain how the server prevents a user from naming
another user's personal destination or fabricating shared access. Preserve the
person in the Account while shared data has deployment-wide ownership.

Resolve whether Personal/Shared selection is per app window or host-wide before
describing its UI as settled. Preserve one primary library per application
document and existing close-before-replacement behavior. Many users managed by
a server must not silently become simultaneous client accounts or a credential
wallet. Define shared-library content deletion separately from operator-only
deployment/user administration and local cache removal.

Separate session authentication from Epicenter Cloud policy. The live
`createSessionAuth` fixes `authorityId` to `epicenter-api` and supplies Cloud
dashboard links. Those assumptions cannot be copied to arbitrary session-issuing
servers. Preserve the official Cloud's durable identity bytes while isolating
other issuers. Keep billing in `apps/api/worker/billing`.

Do not assume changing principal fields migrates old `instance` data. Propose an
explicit migration/import boundary without executing it. Preserve trusted-app
hosting constraints: multiple named users do not authorize serving arbitrary
users' executable code on one trusted origin.

## Worktree and verification limits

The checkout contains extensive tracked and untracked user work in auth, app
bootstrap, inference, recording, and other areas. Inspect `git status --short`,
`git diff --name-status`, and scoped diffs before editing anything. Preserve
unrelated changes; do not reset, stash, or bulk-stage them. No commits, installs,
deployments, migrations, or data deletion are authorized by this handoff.

The original task-start snapshot is
`/tmp/one-active-account-baseline.eVYybD/source.tar`, with an extracted `source`
directory beside it. That snapshot already contains pre-task changes; a diff
against HEAD does not establish authorship. If the temporary snapshot is gone,
report the attribution limit rather than reconstructing ownership by guesswork.

The live caller migration is incomplete. For example, some callers pass
`startup` while shared `AppBoot` still expects `auth`, and some UI still reads
`auth.method`. Do not call this a completed build or preserve those shapes
because they happen to be in the worktree.

The most recent focused check passed 32 tests with 111 assertions:

```sh
bun test packages/auth/src/account-lifetime.test.ts \
  packages/auth/src/instance-auth.test.ts \
  packages/app-shell/src/boot-screens/departure.test.ts
```

That verifies retained lifetime behavior, not the proposed named-user/shared
model. Earlier runtime-selection builds and smokes predate the paused migration
and are not proof that the current tree passes. Re-run relevant checks for any
claim you make. For a design-only pass, distinguish inspected code from tested
prototypes and future evidence targets.

## Completion

Return one recommended API, ownership and authorization rules, concrete
before/after callers, a deletion map, remaining product decisions, and an
ordered implementation plan. Validate the proposal with an independent review
before recommending implementation. Preserve the high-level decision rather
than expanding it into organizations or a generic sharing platform.

The decisive implementation evidence will be Alice and Bob on one server:
isolated Personal libraries, convergent Shared data, and no anonymous shared
access. Repeat with a second server using matching user IDs. Include offline
opening, user removal, credential repair, library changes, and failed close or
relaunch. Keep data from the previous library and server out of the next one.

Leave production changes for the subsequent authorized execution step. Reconcile
the older in-flight spec and draft ADRs once the API direction is settled;
do not mistake their unfinished implementation for completed work to delete.
