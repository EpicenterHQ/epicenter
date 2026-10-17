# 0589. An app is one Git repository of built files at an address

- **Status:** Accepted
- **Date:** 2026-10-17
- **Supersedes:** [ADR-0540](0540-an-app-is-installed-by-building-its-source-and-approving-a-commit-trusts-it-fully.md) (installing builds the app's source on the person's machine); its rule that approving a commit trusts it fully is restated here.
- **Amends:** [ADR-0552](0552-every-app-is-installed-from-a-folder-in-any-git-repository.md) at "installed from a folder in any Git repository", `epicenter.folder`, and `bun install` at the root: an app is a whole repository, built before it is published. [ADR-0560](0560-an-apps-manifest-only-names-it-and-every-installed-app-is-offered-on-every-folder.md) at `epicenter.app.json` and `bun run build:installed` in the folder: there is no manifest and no build on the person's machine. [ADR-0569](0569-the-installed-apps-are-the-clones-in-apps-not-rows-in-so-epicenter.md) at "the clones in `~/Epicenter/Apps/`": the installed apps are clones of built repositories in app data, one directory per encoded address. [ADR-0581](0581-a-desktop-pages-folder-storage-is-one-shell-command-per-storage-method.md) at "The page-to-shell command set is not a cross-version contract" and "an installed app built for the old ones is rebuilt": after the first release the page API changes only by addition. [ADR-0584](0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md) at its wire renames: they land before the first release. [ADR-0586](0586-you-open-a-folder-never-an-app.md) at the reverse-domain id and the manifest folded into the template: an app is named by its address. ADR-0588 (pull request #2565), at building the approved commit on the machine: the build moves to publishing, and the window still runs one approved commit's bytes.
- **Unbuilt:** all of it: the address grammar, its clone rule, the machine-local substitution, and the encoding; the publish step in CI and `epicenter app publish`; per-app repositories under EpicenterHQ, each with a default branch and a `template` branch, created by the owner; an installer that clones, approves, and serves built bytes; approvals keyed by address and commit; OAuth client ids as constants in each app; the page API in a package of its own; and every deletion below.

## Context

An app is a folder inside any Git repository, holding `epicenter.app.json`
with a reverse-domain `id` and a `title` (ADR-0552, ADR-0560). The
installer clones the whole repository into the Epicenter folder's `Apps/`,
records the app's folder as `epicenter.folder` in the clone's
`.git/config` (`FOLDER_KEY`, `packages/cli/src/installed-apps.ts:67`),
finds apps by scanning four directories deep for manifests
(`RepositoryApp`, `:128`; the scan at `:745-752`), checks the id with
`appIdProblem` (`:207`), and builds on the person's machine: `bun install
--frozen-lockfile --ignore-scripts` at the root, then `bun run
build:installed` (`BUILD_SCRIPT`, `:73`; `:989-996`). The Folders window
hard-codes Epicenter's monorepo and `apps/todos` to offer Todos
(`apps/epicenter/src/folders/InstallApps.svelte:23-24`). A browser build
signs in with the manifest's id as its OAuth client id
(`apps/todos/src/lib/platform/auth.browser.ts:20`).

The build runs code from the approved commit and from the machine:
untracked and ignored files in the clone reach the build, which is then
stored under that commit. The page-to-shell command set is "not a
cross-version contract" (ADR-0581), so an installed app is rebuilt with
each shell.

ADR-0585 gives every folder its app's `template` as its Git upstream and
names the app in `epicenter.json` as `app`. ADR-0586 opens a folder in the
app it names.

## Decision

**An app is one Git repository of built files at an address.**

```txt
github.com/EpicenterHQ/todos              the address: host/owner/repo
  default branch                          index.html, assets/: the built app
  template branch                         epicenter.json, README.md, .gitignore: the folder template (ADR-0585)
```

- One approved commit of the default branch supplies every byte a window
  runs. Approving a commit trusts it fully, as ADR-0540 decided.
- Building happens in a publish step, never on a person's machine.
  First-party apps stay developed in the GitHub monorepo, and CI publishes
  each to its own repository. Anyone else publishes with `epicenter app
  publish`. The publisher runs the desktop build (`EPICENTER_HOST=1`,
  `installedAppViteConfig` in `packages/vite-config/src/index.ts`), or the
  repository would hold the browser build.

**An address is `host/owner/repo`, and the app declares its own address in
its repository,** as a Go module declares its path in `go.mod`: the
`template` branch's `epicenter.json` holds it as `app`, and the installer
refuses a repository whose declared address differs from the one it was
installed from.

```json
{ "app": "github.com/EpicenterHQ/todos", "tables": { "todos": { "type": "object", "properties": { "title": { "type": "string" } } } } }
```

- An address is cloned by one fixed rule, `https://<host>/<owner>/<repo>.git`.
- A machine-local substitution maps an address to another clone URL, for
  development and forks; the folder's `app` does not change.
- One reversible, path-safe encoding turns an address into a directory
  name (`<data_dir>/apps/<encoded address>/`), a URL segment, and a window
  label.
- `approvals.json` keys an approval by the readable address and the commit.
- An OAuth client id is a constant in each app's code, registered on the
  server; an address is not an OAuth client.

**The page API between the host and an app is a contract.** After the
first release it changes only by addition. The renames ADR-0584 plans for
desktop commands land before the first release. The page API is generated
into a package apps build against, not into one app's source.

Deleted:

- the install-time build: `BUILD_SCRIPT`, `bun install` in the clone, and
  `build:installed` as the installer's step;
- the subfolder scan: `--folder`, `epicenter.folder` (`FOLDER_KEY`),
  `RepositoryApp`, and listing the apps in a repository;
- `epicenter.app.json`, its parsing, and the hard-coded Todos path in
  `InstallApps.svelte`;
- reverse-domain ids and `appIdProblem`;
- `source` and `title` in `epicenter.json`.

## Consequences

- An approval is of built bytes. A source link in an app's repository is a
  claim by its publisher, not a proof.
- Every app needs a publish step: CI for first-party apps, `epicenter app
  publish` for others.
- The native edit loop becomes: edit, publish locally, approve, reopen.
- The owner creates one repository per first-party app under EpicenterHQ,
  each with a default branch and a `template` branch.
- A window runs exactly the bytes approved; nothing untracked in a clone
  reaches it.
- A shell update does not rebuild installed apps; an app keeps working
  against a newer shell, and a call the shell does not have fails visibly.
- A fork keeps its address in `app`; a person points the address at the
  fork through the substitution, so their folders open in it.

## Considered alternatives

- **Keep building from source on the person's machine.** Approval covers a
  commit, but the build also reads untracked and ignored files and runs
  the repository's tooling, and every shell update rebuilds every app.
- **Keep a reverse-domain id with a `.well-known` file mapping it to a
  source.** It needs a domain and a resolver to do what the address does by
  itself.
- **An app as a folder in any repository.** It needs the subfolder scan and
  `epicenter.folder`, and one approval covers every app in the repository.
- **An address with a scheme or an SSH form.** One fixed clone rule keeps
  the address readable and the clone deterministic; other URLs go through
  the substitution.
