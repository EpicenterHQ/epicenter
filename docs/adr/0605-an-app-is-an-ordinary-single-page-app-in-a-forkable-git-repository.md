# 0605. An app is an ordinary single-page app in a forkable Git repository

- **Status:** Superseded
- **Date:** 2026-10-17
- **Supersedes:** [ADR-0597](0597-an-installed-apps-approved-commit-is-its-bare-clones-detached-head.md) (the bare clone, its detached `HEAD` as the approved commit, and build directories extracted by `git archive` and restored when damaged) and [ADR-0600](0600-an-approved-commit-supplies-a-windows-page-and-its-relative-assets.md) (what an approved commit supplies on the one shared origin): nothing approves a commit, and each app has an origin of its own.
- **Superseded by:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md): the desktop host; Epicenter builds no desktop host, no app registry or installed apps, and no native capabilities.
- **Amends:** [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md) at "An app is one Git repository of built files at an address", the default branch holding "the built app", "Approving a commit trusts it fully", "Building happens in a publish step, never on a person's machine", CI publishing, `epicenter app publish`, "The publisher runs the desktop build", the deleted install-time build, and the consequences about approved built bytes, the publish step, the edit loop, and shell updates: the repository holds source, the desktop builds it with `bun run build`, and installing trusts the author; the address, its clone rule, substitution, encoding, the declared `app`, the page API contract, and the other deletions stand, and the template clauses (`template-commit` and the browser build's template objects) are withdrawn by ADR-0609. [ADR-0598](0598-an-app-is-built-once-and-selects-its-host-implementation-at-run-time.md) at "The one build prerenders every route and also writes a fallback page", the scheme serving each route's prerendered document and a fallback document with an inserted `<base href>`, and "The repository ADR-0589 publishes holds this build": nothing is prerendered, the fallback is `index.html`, and the published repository holds source; run-time host selection and one build stand, and the template paragraph (template history in every build, `template` pushed by fast-forward only) is withdrawn by ADR-0609. [ADR-0561](0561-rust-serves-every-app-from-one-epicenter-app-origin.md) at "Every page shares the one origin", the row `epicenter-app://localhost/apps/<id>/…`, and the consequence that every installed app shares storage with every other: each installed app is served at the root of its own host on the one scheme, and Epicenter's own pages keep `epicenter-app://localhost`. [ADR-0588](0588-an-installed-apps-window-runs-one-approved-commits-own-build.md) at "Every build a window runs was approved when it was built", `needsApproval` for every unapproved `HEAD`, "Every local commit costs one approval", the URL `epicenter-app://localhost/apps/<app-id>/<commit>/`, and "a page may still fetch another build's files": no commit is approved, and a window's label chooses its build on its app's origin; a window keeping the build it opened on, `InstalledWindowCommits`, and the "open on another version" refusal stand. [ADR-0590](0590-every-change-to-the-folder-model-is-checked-against-ten-principles.md) at principle 6, the diagram's bare clones, detached `HEAD`, "one approved app commit", and "one build on the default branch", the Context's "building on the person's machine" among the replaced ideas, and the consequence "publishing and installing are separate modules there": principle 6 is restated below. [ADR-0558](0558-the-epicenter-cli-groups-only-its-app-and-auth-commands.md) at `[--approve]` on `epicenter app install` and `epicenter app update` and "`approve` is part of `install` and `update`": neither takes `--approve`, and neither stops to show a commit. [ADR-0556](0556-outside-a-webview-typescript-runs-only-as-the-epicenter-cli.md) at the approval screen's calls and approvals moving into the CLI, the consequence "An agent with a terminal can run `epicenter app install --approve`", and the alternative's reason "every approved app shares the origin": nothing approves, and each installed app has an origin of its own; ADR-0549's "WebViews hold none" still refuses page-held tokens. [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md) at "the `template` commit the approved app commit names", "the one its installed app's approved commit names", and "authored by the app's publisher": no commit is approved and no publisher exists, and ADR-0609 replaces the template commit with files copied once. [ADR-0539](0539-epicenters-own-folder-is-so-epicenter-and-machine-state-splits-by-what-it-costs-to-lose.md) at "Whatever a person or an agent reads, edits, repairs, or versions as files lives in a folder under the Epicenter root" and built bundles in Caches: an installed app's source clone lives in app data and is authored work, and builds live in app data. [ADR-0560](0560-an-apps-manifest-only-names-it-and-every-installed-app-is-offered-on-every-folder.md) at "Epicenter builds every app with `bun run build:installed` in its folder and keeps `dist/`": Epicenter builds every app with `bun run build` at its repository's root. [ADR-0569](0569-the-installed-apps-are-the-clones-in-apps-not-rows-in-so-epicenter.md) at the clones of built repositories and "the bare clones alone record what is installed and approved": the installed apps are the person's clones of app source, and nothing records an approval. [ADR-0586](0586-you-open-a-folder-never-an-app.md) at "installed as a repository of built files", `approvals.json` and "a clone of the app's built repository" in its app-data tree, and "every window loads `epicenter-app://localhost`": an installed app is the person's clone of its source, and an installed app's window loads its app's own host; and at installing's first folder "named by the last segment of its address": it is named by the app's name, the last segment with a leading `app-` removed. [ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md) at "The proposed name is the folder's directory name, made into a valid name": a data folder's name never begins with `app-`, the prefix of a person's pushed app fork.
- **Unbuilt:** almost all of it: the build contract in Todos, Capture, Honeycrisp, and Whispering (`bun run build` writing `dist/` with `ssr = false` and no prerendering); first-party apps as standalone repositories on published packages; the clone with the author as `upstream`; `epicenter app update` as a merge on `refs/epicenter/candidate` that moves the branch only after its build succeeds; built sites in app data (`builds_dir` and the CLI's `buildsDir` join the cache directory today); the record of each app's current and previous successful builds and "Open previous version"; deleting a build no window pins that is neither of those; one host per installed app and the scheme resolving a request by the window's label; `epicenter app remove` moving the clone to `removed-apps/`; deleting approval; per-app storage isolation beyond `localStorage` within one run on macOS (IndexedDB, OPFS, SharedWorker, BroadcastChannel, and persistence across restarts); every platform but macOS, gated on a probe of per-app hosts on Windows and Linux (WebDriver through `tauri-driver` in CI); an app's name with a leading `app-` removed, naming its first folder and a tab's default folder; pushing a clone as `app-<name>`, refused when the address yields no name; refusing a data folder name that begins with `app-` in Epicenter's clients; open, pending the owner: how a device that installed a person's pushed fork from its own address matches it to folders whose `app` names the author's address (ADR-0589's substitution and declared-address check).

## Context

[ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md)
makes an app a repository of built files: a publisher (CI for first-party
apps, `epicenter app publish` for others) builds it, and the desktop clones
and serves the bytes. [ADR-0597](0597-an-installed-apps-approved-commit-is-its-bare-clones-detached-head.md)
keeps each installed app as a bare clone whose detached `HEAD` is the commit a
person approved, extracts that commit with `git archive` into
`<cache_dir>/builds/<app-id>/<commit>/`, checks the directory at every open,
and restores it when damaged. [ADR-0598](0598-an-app-is-built-once-and-selects-its-host-implementation-at-run-time.md)
builds each app once, prerenders every route for the desktop, and writes a
fallback page that the desktop serves with an inserted `<base href>`.
[ADR-0561](0561-rust-serves-every-app-from-one-epicenter-app-origin.md) serves
every app from `epicenter-app://localhost/apps/<id>/`, one origin shared by
all, and [ADR-0600](0600-an-approved-commit-supplies-a-windows-page-and-its-relative-assets.md)
concedes that any page there can load another build's files.

The code is between these: `build` in `packages/cli/src/installed-apps.ts`
extracts the approved commit, runs `bun install --frozen-lockfile
--ignore-scripts` and `bun run build:installed` with the CLI's own binary
(`buildEnvironment`, `process.execPath` with `BUN_BE_BUN=1`), and records
`dist/` as a tree in the clone; `remove` deletes the clone because it "holds
nothing its remote lacks"; `apps/epicenter/src-tauri/src/scheme.rs` serves
`/apps/<id>/<commit>/` on the host `localhost`.

Three findings broke this shape:

- A person who changes an app, or has an agent change it, needs source to
  merge the author's next version into. A built repository holds minified
  chunks, so a merged result exists nowhere as a build until something builds
  it on the machine.
- SvelteKit's fallback document is not relative. A spike on kit 2.65.1 and
  adapter-static 3.0.10, in Chromium and WebKit, found its assets
  root-absolute (`/_app/...`) and its router base the literal `""`, so an
  inserted `<base href>` loads nothing and routes nothing below a prefix.
  Served at an origin's root, the same unchanged fallback renders a dynamic
  route (`/todo/42` with `id=42`) on macOS WKWebView with Tauri 2.12.1.
- One scheme can carry many hosts. A probe on macOS with Tauri 2.12.1 and wry
  0.57.0 opened `epicenter-app://localhost/`, `epicenter-app://appb/`, and
  `epicenter-app://appc.localhost/` side by side: each was a secure context
  with `crypto.subtle` and IPC under the existing `"local": true`
  capability, and each saw only its own `localStorage` keys, and the handler
  received the host intact. A spike of eleven windows on one host found the
  window label on every request (documents, scripts, dynamic imports,
  workers, `fetch`), with none misattributed.

## Decision

> **An Epicenter app is an ordinary single-page app in a Git repository that anyone can fork. Epicenter itself is just three things: a library the app imports, a desktop that builds each app and hosts it at its own address with native powers, and a Git service that stores your folders and your forks.**

**An app's whole contract is that `bun run build` at its repository's root
writes a static site to `dist/`, with `index.html` at its root, built for the
root path.** It is a single-page app built with Vite. No route is rendered at
build time. A SvelteKit app uses adapter-static writing `dist/` with
`fallback: 'index.html'`, and sets `export const ssr = false` in its root
`+layout.ts`; it sets no `prerender`.

```txt
<repository>/
  package.json        "build": writes dist/
  bun.lock
  src/ ...
  dist/               written by `bun run build`, never committed
    index.html        the one document; every route renders in the page
    assets/ ...       referenced from the root: Vite's /assets/, SvelteKit's /_app/
```

**Every host serves an app by one rule: the file at the path if it exists,
otherwise `index.html`.** Epicenter offers no app hosting (ADR-0593,
ADR-0594); an author deploys their own.

**Each app is served at the root of an origin of its own.** A host that
gives each app its own origin root meets the contract, and a host that
serves an app under a subpath does not:

```txt
https://board.pages.dev/          Cloudflare Pages, one project per app   meets it
https://board.alice.dev/          a custom domain                         meets it
https://alice.github.io/board/    a GitHub Pages project site             does not: a subpath, and every project
                                                                          of alice shares one origin and so one
                                                                          OPFS root
```

**The desktop is one more static host, with native powers.** It serves each
installed app at the root of its own host on the one scheme:

```txt
epicenter-app://localhost/<page>/...     Epicenter's own pages, unchanged (ADR-0561)
epicenter-app://<app host>/<path>        one installed app; <app host> is never localhost
```

- `<app host>` is derived from the app's address and stays the same across
  updates and the person's commits, so the app's storage stays with it. The
  probe showed each host seeing only its own `localStorage` keys, within one
  run on macOS; IndexedDB, OPFS, SharedWorker and BroadcastChannel
  isolation, and persistence across restarts, are not yet shown.
- The scheme serves `<path>` from the build the requesting window's label is
  pinned to (`InstalledWindowCommits`), by the rule above. A request whose
  label names no window of that app is refused.
- macOS is the first platform. Windows and Linux are unbuilt until a probe
  shows per-app hosts there.

**Installing an app gives the person their own repository, forked from the
author's source.**

```txt
<data_dir>/apps/<encoded address>/            a clone of the author's repository, with a working tree
  .git/config                                 remote "upstream" = https://<host>/<owner>/<repo>.git (ADR-0589)
<data_dir>/builds/<encoded address>/<commit>/ dist/ of one commit, built on this machine
<data_dir>/removed-apps/<encoded address>/    a removed app's clone, kept whole
```

- The desktop builds a commit of the clone, never its working tree, with the
  CLI's bundled Bun, as `build` does today: `bun install --frozen-lockfile
  --ignore-scripts`, then `bun run build`.
- Builds will live in app data, so an installed app opens with no network
  and nothing purges a build. Today both `builds_dir` in
  `apps/epicenter/src-tauri/src/app_data.rs` and `buildsDir` in
  `packages/cli/src/app-paths.ts` join the cache directory. Today's restore
  of a damaged build from the clone is deleted only once both join the data
  directory.
- A person's or an agent's change to an app is a commit in that clone.
- `epicenter app update` refuses while the clone's working tree has
  uncommitted changes. Otherwise it fetches `upstream`, merges it onto the
  candidate ref `refs/epicenter/candidate`, never onto the person's branch,
  builds that commit, and opens a window on that build. Only when the build
  succeeds and its window opens does the person's branch move to the
  candidate commit; the build it replaces stays as the previous build,
  which "Open previous version" reopens. When the person's commits conflict, it stops on the
  candidate and lists the conflicted files, and an agent resolves the Git
  merge and commits there. A failed build leaves the branch where it was.
- An app's name is the last segment of its address (ADR-0602) with a
  leading `app-` removed, made into a repository name by `toRepositoryName`
  (`packages/constants/src/repositories.ts`) and cut to 96 characters, so
  that `app-` and the name stay within `MAX_REPOSITORY_NAME_LENGTH`, 100:
  `github.com/alice/kanban` and `github.com/alice/app-kanban` both have the
  name `kanban`. Installing names the app's first folder by it (ADR-0586),
  and a tab names its default folder by it (ADR-0607).
- Pushing the clone to the person's hosted Git is optional. It is pushed
  as `app-<name>`, `<name>` being the app's name: a fork of either address
  above is pushed to `git.epicenter.so/<namespace>/app-kanban`, never
  `app-app-kanban`. When `toRepositoryName` yields no name for the last
  segment, the app still installs and runs locally, and pushing its fork is
  refused with a message naming the address. Once pushed, another device
  installs the person's version from that address.
- A data folder's name never begins with `app-`. Making, connecting, or
  cloning a data folder refuses such a name, and ADR-0546's alphabet (`isRepositoryName`)
  stands otherwise, so in `GET /api/repos` a name beginning with `app-` is
  an app fork and every other name is a data folder, and "Clone from
  Epicenter" offers only the data folders.
- `epicenter app remove` keeps the source clone, which is authored work: it
  moves `<data_dir>/apps/<encoded address>/` whole, working tree included,
  to `<data_dir>/removed-apps/<encoded address>/`, and installing that
  address again moves it back. Nothing deletes a clone.

**Installing an app trusts its author fully, with the person's account and
machine and every folder in it.** The build runs the
author's scripts as the person, and an agent resolving a merge runs the
author's code to check its work. There is no per-commit approval: the bytes
that run need not be bytes the person approved commit by commit, and nothing
shows the person an update before it builds.

**A window keeps the build it opened with, and a build that fails never
replaces the one that works.** The desktop records, per app, the current
build (the commit whose build last succeeded) and the previous one, and a
new window opens the current build. A failed build leaves the record and
every running window as they were, and its log names what failed.

**Principle 6 of [ADR-0590](0590-every-change-to-the-folder-model-is-checked-against-ten-principles.md)
reads:** An app is an ordinary single-page app in a Git repository at an
address, whose `bun run build` writes a static site to `dist/` that any static
host serves at the root of an origin of its own, built once for every host
(ADR-0605, ADR-0598). On the desktop an
installed app is the person's own clone of that source, with the author as
`upstream`, built on the machine and served at the root of its own origin
(ADR-0605).

Deleted:

- approval: `APPROVAL_STATEMENT`, `approveCommit`, `approvedCommit`,
  `requireShownCommit`, `requireApprovalForCommit`, `needsApproval`, the
  bare clone and its detached `HEAD`, and the Folders window's approval step;
- built trees: `buildTree`, `recordTree`, `refs/epicenter/builds/<commit>`,
  `matchesTree`, `hashEntries`, `provide`, the check at every open, and,
  once builds live in app data, the damaged-build restore with
  `BuildReservation` and `WindowPins.restoring` in
  `apps/epicenter/src-tauri/src/lib.rs`;
- prefix serving: `installed_app_path` and the `/apps/<id>/<commit>/` routes
  in `scheme.rs`;
- prerendering: every route document, the fallback named apart from
  `index.html`, and the inserted `<base href>` (ADR-0598);
- publishing: the publish step in CI, `epicenter app publish`, and the
  per-app repositories of built files (ADR-0589).

**A data folder copies its app's template once, and app updates never
merge into it (ADR-0609).** ADR-0589's `template-commit`, ADR-0598's
template history in every build, and the fast-forward-only push of
`template` were written by the publisher deleted above, and ADR-0609
withdraws them: `epicenter app update` is the only update verb, and only an
app's clone has an `upstream`.

## Consequences

- An install and every update need the network and a build. A probe of
  today's installer building Todos measured about 15 s cold and 7 to 9 s warm,
  and about 258 MB downloaded into a 1.1 GB cache, because Todos still
  installs the whole monorepo's lockfile. A standalone Todos needs 15
  workspace packages published or vendored first.
- Builds are not reproducible as configured: SvelteKit's `kit.version.name`
  defaults to `Date.now()`, and Svelte's scoped class hashes depend on the
  build's absolute path. Two machines can run different bytes from one
  commit. Pinning the version name and building at a fixed path made two
  builds identical in the probe.
- An agent merged a real conflicting upstream refactor of Todos into a
  customization in about a minute (5 hunks in 2 files), with typecheck and
  tests green. The tests did not cover the customization, so a clean merge
  shows nothing regressed, not that the change still works.
- A desktop window and a browser tab run builds of the same source; a
  person's own commits reach a tab only if that person deploys their fork.
- A static host that answers a missing path with a 404 page needs the app's
  `index.html` copied there: GitHub Pages under a custom domain serves
  `404.html`. No host was
  probed.
- A third-party author ships source that builds with Epicenter's Bun alone,
  against published packages, with a frozen `bun.lock`.
- A shell update rebuilds nothing: each build is kept by commit, and a new
  commit builds with the Bun the shell ships at that time.
- The desktop deletes a build that no window pins and that is neither the
  current nor the previous successful build, so `builds/` holds at most
  those two plus the pinned ones; app data is not purged as a cache is.
- `removed-apps/` keeps every removed app's clone until the person deletes
  it.
- The hosted service checks only `isRepositoryName` when a push creates a
  repository (`packages/server/src/routes/git.ts:195`) and when it renames
  one (`packages/server/src/repositories.ts:241`), and it cannot tell a
  fork's first push from a folder's. Only Epicenter's own clients enforce
  the `app-` rule: a plain `git push` can create a folder named `app-x`,
  which every listing then treats as an app fork.
- A namespace holds one pushed fork per app name: a person who forks
  `github.com/alice/kanban` and `github.com/bob/kanban` cannot push the
  second as `app-kanban`, since a push of unrelated history to an existing
  repository is refused (ADR-0546). No data folder's name can begin with
  `app-`.
- An author's new commit can run on the person's machine without anyone
  seeing its diff. `epicenter app update` is a CLI command that agents run,
  and a clean merge builds and becomes the current build with nothing
  asking the person.
- No build is sandboxed. A build runs as the person, with the inherited
  environment, inside the CLI's own binary (`BUN_BE_BUN=1`), which is the
  program Epicenter's keychain entries are stored by, so nothing keeps a
  build from the person's files or those entries.

## Considered alternatives

- **Keep built repositories and a publisher (ADR-0589).** A merge of the
  author's update with the person's commits needs source, so the built
  repository becomes a second artifact beside it.
- **Prerender every route and serve under a per-commit prefix (ADR-0598).**
  The fallback's root-absolute assets and empty base make it fail below a
  prefix; fixing it means rewriting SvelteKit's emitted HTML.
- **The desktop as a browser that loads each author's deployed URL.** An
  installed app would need the network to open, and a person's commits would
  run only after they deploy them.
- **Approve every commit before it builds.** The agent resolving a merge has
  already run the author's code by the time anyone approves, so the approval
  guards nothing the install did not already trust.
- **A scheme per app.** Not needed on macOS, where one scheme with a host
  per app gave each app its own `localStorage` without registering anything
  after startup. Open for Windows and Linux, where Tauri may not give each
  host its own origin.
- **Serve an app under a subpath of a shared origin (a GitHub Pages project
  site).** Every app on that origin shares one storage and one OPFS root,
  and the app must be built for its prefix, which a fork moved to another
  address would rebuild.
