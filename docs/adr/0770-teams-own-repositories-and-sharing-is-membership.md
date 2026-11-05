# 0770. Teams own repositories, and sharing is membership

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0547](0547-every-repository-has-one-owner-namespace-and-a-person-is-a-namespace-of-one.md) at "no one is added to a personal namespace", "Sharing a folder is moving it into a group", and the rejected "team" on screen: a person's first team takes members like any other, and nothing moves; [ADR-0594](0594-a-hosted-repository-is-reached-only-by-the-person-who-owns-it.md) and [ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md) at a repository's own access list: access is the team's membership; [ADR-0708](0708-a-namespace-holds-documents-beside-repositories-under-one-resource-grant.md) at "One grant covers both kinds" and `share`/`unshare`: there are no per-resource grants; [ADR-0732](0732-a-grant-reaches-what-the-person-chooses-at-consent.md) at what consent offers: a team, and the app's repository in it.
- **Relates:** [ADR-0593](0593-the-hosted-git-service-stores-data-repositories-and-offers-no-rename-or-move.md) (no move, which this keeps), [ADR-0722](0722-an-apps-names-derive-from-its-sites-host.md) (an app's repository name comes from its site), [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) (apps share data through files in Git).
- **Amended by:** [ADR-0771](0771-plain-files-let-epicenter-refuse-renames-attachment-conflict-copies-and-a-second-store.md) at "clone, then push" and "owners also rename": a copy is one commit of files, and owners rename a team, never a repository.
- **Amended by:** [ADR-0772](0772-a-folder-says-what-it-is-in-agents-md-and-this-computer-keeps-the-rest.md) at where a team's repositories sit on a computer: in the team's folder under `~/Epicenter`.
- **Amended by:** [ADR-0802](0802-people-share-spaces-an-app-works-in-one-at-a-time-and-a-folder-carries-its-contract.md) at the noun team and consent choosing a team: the noun is space, and consent chooses the spaces an app may reach.
- **Unbuilt:** all of it: renaming the `namespace` tables to `team` and `team_member`; deleting `repository_grant`, `share` and `unshare`; creating a team, inviting to it, and leaving it; consent offering a team; `GET /api/repos` and `epicenter repos` listing by team.

## Context

Two ways to share were in the schema at once. A namespace has members
(`namespace_member`, owner or member) who reach everything in it, and a
`repository_grant` lets one person outside it `read` or `write` one
repository. Only the grant had a working path (`epicenter share`), because
creating a group and inviting to it were never built. Every question about
who reaches a repository had to ask which of the two applied.

An app's repository is already named by its site (`todos` for Todos,
ADR-0722), so a person has at most one repository per app in each place
that owns repositories. Choosing "which repository should Todos open" is
choosing which owner's.

## Decision

**A team owns repositories, and sharing is being in the team.**

```txt
team         id · name                    one is created with each account, named for the person
team_member  team · account · role        owner | member
repository   id · team · name             name unique within its team
```

A person's first team is an ordinary team: they can invite people into it
like any other, and can make more. Members reach every repository in the
team; owners also rename and delete, and change members. There are no
per-repository grants, so one rule answers who reaches a repository: its
team's members. Sharing one app's data with one person is a team of two.

**Nothing moves between teams.** A team's repository for an app starts
empty and is created by its first push (ADR-0546), and a repository's
address never changes: `<team>/<name>`, where the team is its id and the
name comes from the site. Sharing data that already exists means inviting
people into the team that holds it. Splitting one team's data into another
is copying it, which Git already does (`epicenter clone`, then push into
the other team's repository); the service offers no move (ADR-0593).

**An app chooses a team at consent, never a repository.** Consent asks
which team an app keeps its data in, preselecting the person's first team,
and the grant names that team's repository for the app. The app's code
never names a repository:

```ts
export const folder = openFolder(todos, home({ site: APPS.TODOS.url, account }));
// on the web, home() opens the repository of the team chosen at consent
```

**The noun is team, in code and on screen.** `namespace` and
`namespace_member` become `team` and `team_member`, and the first team keeps
the fact of whose it was first (`created_for_account_id`), which preselects
it at consent and resolves `~` in the CLI; it limits nothing.

## Consequences

- One sharing mechanism. `repository_grant`, `share`, `unshare`, and the
  question of which rule applies go.
- Every app gets sharing without code of its own: no picker, no
  `?repository=` link, and no repository name in app code.
- No moves and no aliases for moves: an address is fixed for the life of
  the repository.
- Inviting someone into a team shares every app's data in it. A person who
  wants to share only Todos makes a team for it, and its Todos starts empty.
- Read-only sharing goes with the grant's `read` level. Two roles remain.
- An app opens one team's repository at a time. Showing several teams' data
  in one app would be a new kind of app, with a folder per team.

## Considered alternatives

- **A personal namespace no one joins (ADR-0547).** Keeps "anything in
  Personal is only yours" true by construction, but makes the first share a
  new team and, without moves, a fresh start. Refused: a person's first team
  is where their data already is.
- **Per-repository grants beside teams (today's schema).** Finer control at
  the cost of a second rule for every access question. Refused.
- **Moving a repository into a team (ADR-0547's "Share…").** Shares existing
  data in one step, but needs id-based addresses or aliases (ADR-0612,
  ADR-0593). Refused: inviting into the holding team covers sharing what
  exists, and Git copies the rest.
- **A read-only role (`viewer`).** Refused by ADR-0547; not reinstated here.
  It returns as one row of the role table if read-only sharing is needed.
