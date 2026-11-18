# 0954. `new --from` is a sparse Git checkout of one folder

- **Status:** Proposed
- **Date:** 2026-11-17
- **Amends:** [ADR-0929](0929-new-copies-an-apps-code-from-a-folder-in-git-or-a-folder-on-github.md) at "When the named folder holds several apps, `new` lists them and prints the `--from` for one": a folder without an app is refused, and the person names the app's folder. [ADR-0946](0946-new-from-a-local-folder-refuses-uncommitted-code.md) at "not the copy's filter": there is no filter.
- **Relates:** [ADR-0911](0911-export-copies-an-apps-committed-code-into-a-refreshable-directory.md) (export keeps its own copy rules)

## Context

`new --from` copied an app's committed folder by hand. It read the index,
filtered paths (`data/`, `node_modules`, `ui/dist`, `.DS_Store`, an old
`SOURCE.md`), checked files out one list at a time with LFS filters forced
on, refused gitlinks, added LFS attributes the copy lost, listed the apps in a
folder that held several, deleted a copied `bun.lock`, and removed any
`@epicenter/app` from the copy's `package.json`. Each rule was a promise Git
or Bun already keeps, or one the person can see for themself.

## Decision

`new --from` makes `apps/<name>/code` from one committed app folder, using
Git the way a person would:

1. Clone the source into the new container without checking anything out:
   a local repository as is, a GitHub one shallow and without file contents.
2. Find the app: the named folder if it tracks `epicenter.ts`, else its
   `code/`. Otherwise refuse.
3. For a local source, refuse uncommitted code (ADR-0946).
4. Check out only that folder (`git sparse-checkout set`, cone mode), move it
   to `code/`, and delete the clone.
5. Rename the copy's `package.json`, if it has one, to the app, and refuse one
   that is a link, since writing it would write the file it points to.
6. Write `SOURCE.md`.

What the commit holds is what the copy holds. Git keeps modes and links, and
runs LFS as the person's Git is configured to.

## Consequences

- A committed `data/`, `node_modules/` or `ui/dist/` inside the copied folder
  is copied. An app container's records are beside `code/`, so a current app
  never commits them there.
- LFS files arrive as content when the person's Git has `git lfs install`,
  and as pointer files otherwise. The home stores them with its own
  attributes; `new` adds none.
- A gitlink in the source arrives as an empty folder, as in any checkout.
- A folder that holds several apps is refused with "name the app's folder",
  not a list.
- A copied `bun.lock` stays; Bun ignores a lock inside a workspace package.
  A copy that lists its own `@epicenter/app` is reported by `epicenter`, like
  any app that would load its own copy.
- Code with no `package.json` gets none; the home's install still resolves
  `@epicenter/app` for it.
- `new.ts` no longer uses `code-copy.ts`; export does.
