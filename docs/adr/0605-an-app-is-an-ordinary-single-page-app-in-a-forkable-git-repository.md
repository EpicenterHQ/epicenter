# 0605. An app is an ordinary single-page app in a forkable Git repository

- **Status:** Accepted
- **Date:** 2026-10-17
- **Supersedes:** [ADR-0597](0597-an-installed-apps-approved-commit-is-its-bare-clones-detached-head.md) (the bare clone, its detached `HEAD` as the approved commit, and build directories extracted by `git archive` and restored when damaged) and [ADR-0600](0600-an-approved-commit-supplies-a-windows-page-and-its-relative-assets.md) (what an approved commit supplies on the one shared origin): nothing approves a commit, and each app has an origin of its own.
- **Amends:** [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md) at "An app is one Git repository of built files at an address", the default branch holding "the built app", "Approving a commit trusts it fully", "Building happens in a publish step, never on a person's machine", CI publishing, `epicenter app publish`, "The publisher runs the desktop build", the deleted install-time build, and the consequences about approved built bytes, the publish step, the edit loop, and shell updates: the repository holds source, the desktop builds it with `bun run build`, and installing trusts the author; the address, its clone rule, substitution, encoding, the declared `app`, the page API contract, the template clauses, and the other deletions stand. [ADR-0598](0598-an-app-is-built-once-and-selects-its-host-implementation-at-run-time.md) at "The one build prerenders every route and also writes a fallback page", the scheme serving each route's prerendered document and a fallback document with an inserted `<base href>`, and "The repository ADR-0589 publishes holds this build": nothing is prerendered, the fallback is `index.html`, and the published repository holds source; run-time host selection, one build, and the template paragraph stand. [ADR-0561](0561-rust-serves-every-app-from-one-epicenter-app-origin.md) at "Every page shares the one origin", the row `epicenter-app://localhost/apps/<id>/…`, and the consequence that every installed app shares storage with every other: each installed app is served at the root of its own host on the one scheme, and Epicenter's own pages keep `epicenter-app://localhost`. [ADR-0588](0588-an-installed-apps-window-runs-one-approved-commits-own-build.md) at "Every build a window runs was approved when it was built", `needsApproval` for every unapproved `HEAD`, "Every local commit costs one approval", the URL `epicenter-app://localhost/apps/<app-id>/<commit>/`, and "a page may still fetch another build's files": no commit is approved, and a window's label chooses its build on its app's origin; a window keeping the build it opened on, `InstalledWindowCommits`, and the "open on another version" refusal stand. [ADR-0540](0540-an-app-is-installed-by-building-its-source-and-approving-a-commit-trusts-it-fully.md) at "approving a commit trusts it fully", as ADR-0589 restated it: installing an app trusts its author fully, and nothing approves a commit. [ADR-0590](0590-every-change-to-the-folder-model-is-checked-against-ten-principles.md) at principle 6 and the diagram's bare clones, detached `HEAD`, "one approved app commit", and "one build on the default branch": principle 6 is restated below; principle 5 stands. [ADR-0560](0560-an-apps-manifest-only-names-it-and-every-installed-app-is-offered-on-every-folder.md) at "Epicenter builds every app with `bun run build:installed` in its folder and keeps `dist/`": Epicenter builds every app with `bun run build` at its repository's root. [ADR-0569](0569-the-installed-apps-are-the-clones-in-apps-not-rows-in-so-epicenter.md) at the clones of built repositories and "the bare clones alone record what is installed and approved": the installed apps are the person's clones of app source, and nothing records an approval. [ADR-0586](0586-you-open-a-folder-never-an-app.md) at "installed as a repository of built files", `approvals.json` and "a clone of the app's built repository" in its app-data tree, and "every window loads `epicenter-app://localhost`": an installed app is the person's clone of its source, and an installed app's window loads its app's own host.
- **Unbuilt:** almost all of it: the build contract in Todos, Capture, Honeycrisp, and Whispering (`bun run build` writing `dist/` with `ssr = false` and no prerendering); first-party apps as standalone repositories on published packages; the clone with the author as `upstream`; `epicenter app update` as a fetch and merge of `upstream`; built sites in app data; the pointer to each app's last build that succeeded; one host per installed app and the scheme resolving a request by the window's label; `epicenter app remove` keeping local-only commits; deleting approval; every platform but macOS, gated on a probe of per-app hosts on Windows and Linux (WebDriver through `tauri-driver` in CI); and how a device that installed a person's pushed fork from its own address matches it to folders whose `app` names the author's address (ADR-0589's substitution and declared-address check).

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
otherwise `index.html`.** Every app is a static site that any static host
serves at the root of an origin (Cloudflare, GitHub Pages, others). Epicenter
offers no app hosting (ADR-0593, ADR-0594); an author deploys their own.

**The desktop is one more static host, with native powers.** It serves each
installed app at the root of its own host on the one scheme:

```txt
epicenter-app://localhost/<page>/...     Epicenter's own pages, unchanged (ADR-0561)
epicenter-app://<app host>/<path>        one installed app; <app host> is never localhost
```

- `<app host>` is derived from the app's address and stays the same across
  updates and the person's commits, so the app's storage persists and no
  other app shares it.
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
```

- The desktop builds a commit of the clone, never its working tree, with the
  CLI's bundled Bun, as `build` does today: `bun install --frozen-lockfile
  --ignore-scripts`, then `bun run build`. `builds_dir` in
  `apps/epicenter/src-tauri/src/app_data.rs` joins `data_dir`, not
  `cache_dir`, so an installed app opens with no network.
- A person's or an agent's change to an app is a commit in that clone.
- `epicenter app update` fetches `upstream`, merges it into the person's
  branch, and builds the result. When the person's commits conflict, it
  stops and lists the conflicted files, and an agent resolves the Git merge
  and commits.
- Pushing the clone to the person's hosted Git is optional. Once pushed,
  another device installs the person's version from that address.
- `epicenter app remove` never deletes a commit that exists only in the
  clone: it refuses while any commit on the clone's branches is reachable
  from no remote-tracking ref, and names those commits.

**Installing an app trusts its author fully, with the person's account and
machine, not only the folder a window is handed.** The build runs the
author's scripts as the person, and an agent resolving a merge runs the
author's code to check its work. There is no per-commit approval: the bytes
that run need not be bytes the person approved commit by commit, and pulling
an update is the person's own act.

**A window keeps the build it opened with, and a build that fails never
replaces the one that works.** The desktop records, per app, the commit whose
build last succeeded, and a new window opens that build. A failed build
leaves the record and every running window as they were, and its log names
what failed.

**Principle 6 of [ADR-0590](0590-every-change-to-the-folder-model-is-checked-against-ten-principles.md)
reads:** An app is an ordinary single-page app in a Git repository at an
address, whose `bun run build` writes a static site to `dist/` that any static
host serves, built once for every host (ADR-0605, ADR-0598). On the desktop an
installed app is the person's own clone of that source, with the author as
`upstream`, built on the machine and served at the root of its own origin
(ADR-0605).

Deleted:

- approval: `APPROVAL_STATEMENT`, `approveCommit`, `approvedCommit`,
  `requireShownCommit`, `requireApprovalForCommit`, `needsApproval`, the
  bare clone and its detached `HEAD`, and the Folders window's approval step;
- built trees: `buildTree`, `recordTree`, `refs/epicenter/builds/<commit>`,
  `matchesTree`, `hashEntries`, `provide`, the check at every open, and the
  damaged-build restore with `BuildReservation` and `WindowPins.restoring` in
  `apps/epicenter/src-tauri/src/lib.rs`;
- prefix serving: `installed_app_path` and the `/apps/<id>/<commit>/` routes
  in `scheme.rs`;
- prerendering: every route document, the fallback named apart from
  `index.html`, and the inserted `<base href>` (ADR-0598);
- publishing: the publish step in CI, `epicenter app publish`, and the
  per-app repositories of built files (ADR-0589).

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
  `index.html` copied there: GitHub Pages serves `404.html`. No host was
  probed.
- A third-party author ships source that builds with Epicenter's Bun alone,
  against published packages, with a frozen `bun.lock`.
- A shell update rebuilds nothing: each build is kept by commit, and a new
  commit builds with the Bun the shell ships at that time.
- `builds/` grows by one directory per built commit in app data until cleanup
  exists, and app data is not purged as a cache is.
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
- **A scheme per app.** One scheme with a host per app gave each app its own
  storage on macOS without registering anything after startup.
