# 0677. One source repository can provide many desktop apps

- **Status:** Proposed
- **Date:** 2026-10-22
- **Relates:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md) and [ADR-0635](0635-generic-desktop-data-tools-are-deferred.md) (the present, narrower desktop runner); [ADR-0674](0674-standalone-apps-release-independently-from-one-monorepo.md) (standalone releases and fixed bundled pages); historical [ADR-0605](0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md) (a retired source-install and merge design).
- **Unbuilt:** Source installation, app manifest discovery, user-owned checkout registration, installed builds, update discovery, agent-assisted merge workflow, and native admission for installed pages. The desktop currently bundles fixed app pages; it does not install their source.

## Context

Epicenter desktop builds its fixed app pages when Epicenter itself is built.
ADR-0611 and ADR-0635 describe a possible personal-tool runner for built
local pages, but no arbitrary runner is implemented. Those decisions
explicitly removed the former source installer. ADR-0674 gives standalone
products independent releases; their installers are separate from pages
served by Epicenter.

That arrangement makes a source-editable app inside Epicenter impossible to
install from a public Git URL. A person who wants an agent to change Todos's
layout needs a Git checkout and a build, whether Epicenter manages those or
the person does. A browser deployment has a different job: it serves an
already built site and may use Git to synchronize data, but it need not clone
and build its own application source.

The retired [ADR-0552](0552-every-app-is-installed-from-a-folder-in-any-git-repository.md)
allowed an app to live inside a repository, but installed two apps from one
repository as two whole clones. The retired ADR-0605 treated an app's clone
as the person's fork, let an update merge the author's commits with local
commits, and kept a previous successful build. This record reopens editable
source without equating one app with one clone or inheriting the old paths,
commands, and permission grants.
If accepted, it would amend ADR-0611 and ADR-0635 at the prohibition on
source acquisition and builds in the desktop runner. Replacing the fixed
first-party bundles would also amend ADR-0674's bundled-page release rule;
standalone products would retain their independent releases.

## Decision

**One Git checkout can provide several desktop app targets.**

The source repository is the unit a person and agent edit. Each app target
has a tracked `epicenter.app.json` in its own directory, including the
repository root when the repository contains only one app. Epicenter finds
those manifests wherever they occur; `apps/` is a convention in this
monorepo, not a required path in other repositories. A manifest identifies
the app and its desktop-host build and output locations. Adding a repository
discovers its app targets; the person chooses which targets to build and open.

Epicenter can clone a remote into an ordinary, user-accessible source
directory or register an existing local checkout without moving it. The UI
shows a suggested destination in the install confirmation and lets the person
change it or select an existing checkout. The suggestion is a convenience,
not a required source root such as `~/Developer`. It must be outside the
local-data library, Epicenter's application-data directory, and another Git
worktree. An occupied destination is never overwritten or silently renamed:
an existing checkout can be registered in place, or the person can choose
another destination. Epicenter reuses a registered checkout when the person
adds another app target from that repository. Each Git worktree is a separate
checkout when its branch must differ. Epicenter does not extract one app's
files into a pretend repository or keep one hidden clone per app.
Removing an app entry or its built output does not delete the checkout or
the app's data. Epicenter never silently removes a checkout it created;
deleting source is a separate, explicit file operation.

A catalog entry supplies a repository URL and optionally an app path; it
owns neither the checkout nor access to the remote. A public HTTPS
repository can be cloned without an Epicenter or GitHub account; building
it also requires access to its dependencies. Private fetches use credentials
configured for that Git remote.

**The CLI owns installed-source state; the desktop reads it.**

The installed inventory is `<dataDir>/installed-apps.json`, where `dataDir`
is Epicenter's machine-local application-data directory. Completed builds
live under `<dataDir>/app-builds/<installation-key>/<build-id>/`. The
inventory names each checkout, target path, opaque local installation key,
and active build. The installation key is assigned locally; a manifest's
name or identifier cannot select another app's runtime identity. The CLI is
the only writer of this inventory and its built outputs. It serializes
competing changes from terminal and desktop invocations. Epicenter's UI
reaches those same CLI operations through fixed host commands, while Rust
reads the inventory to open an installed page. Manifests are discovered from
tracked files in the checkout, not from dependencies or generated output.
Missing checkouts remain visible as unavailable sources; an existing active
build can still open.

The installation key is a native identity, not the normal CLI address. A
terminal build or open command selects the exact registered app directory,
defaulting to the current directory when no path is given. It does not infer a
target from a repository root, display name, manifest identifier, or Git
remote. The CLI resolves that directory to its installation key before
building or asking Rust to open a window. An explicit `--id` selector supports
scripts and opening a completed build when source is missing; it cannot be
combined with a directory argument. Desktop rows use the key internally. One
canonical app directory has at most one installation, so adding it again
reuses its key; distinct worktrees have distinct keys. Moving source never
silently transfers an installation. Preserving its origin and builds after a
move requires an explicit source rebind.

**The checkout's branch belongs to the person and agent, not to Epicenter.**

A new clone starts from the remote's chosen ref; no branch name such as
`main` is required. The checkout's working branch and the upstream ref
that Epicenter checks for updates are separate choices. An agent may edit,
commit, inspect history, and merge the author's changes on the person's
branch. Epicenter does not switch or rewrite that branch during background
update discovery. Cloning an author's repository does not create a remote
fork or give the person permission to push there. Local commits can be merged
with later upstream commits without a fork, but they remain only on that
computer until pushed to a remote or backed up separately. A personal fork,
private Git remote, or other backup is optional for local editing; people
who want their customizations available after device loss or on another
computer must publish or back them up themselves. Epicenter should make
that local-only state visible, not imply that a commit was backed up.
If two apps need different source branches, the person can use separate Git
worktrees or checkouts rather than pretending one working tree has two current
branches.

**A new remote checkout starts with limited history, not a permanently limited Git repository.**

When the remote supports it, installation fetches the selected ref shallowly
to avoid transferring older commits most people will not inspect. Normal
future fetches bring in new commits and preserve the installation commit as
the base for local edits when upstream retains that ancestry. An agent can
deepen the repository when older history or another branch is needed.
Repeating a depth-one fetch for every update is not the update rule.
Shallow history does not omit current files or dependencies. Sparse checkout
and partial clone may reduce monorepo file
transfer after the required build paths are known, but neither is part of
the app identity or required for a correct install.

**Updating source is an explicit Git operation, followed by a separate build.**

Epicenter can fetch the selected upstream ref and report that a newer commit
is available without changing the checkout or active build. It exposes the
current and candidate commits and their diff so a person or agent can
propose the update. For a clean checkout, advancing to that commit can be a
direct update. Uncommitted work must be preserved or committed before an
update changes the checkout. When the person has committed customizations,
the person or agent merges the selected upstream commit into their branch and runs checks
in the ordinary checkout. Epicenter does not silently resolve conflicts or
rewrite the person's commits. An unfinished merge stays visible as source
work; it does not become an installed build. The selected upstream ref may
move, but each build records the checkout's HEAD and whether local edits were
included. A dirty build cannot be attributed to HEAD alone.

**A successful build becomes active without replacing an open page.**

Epicenter builds each chosen app into a new, immutable output directory in
its machine-local application data, separate from the checkout and from
disposable caches. A build may include uncommitted working-tree changes. It
records the source HEAD, whether local changes were present, the app target,
and the host API version; HEAD alone does not identify a dirty build's input
or the resulting bytes. Once the completed build passes compatibility checks,
the CLI atomically makes it active. A failed or cancelled build leaves the
previous active build in place. Rust opens only a compatible active build and
keeps an open window on the build it started with. Two apps from the same
checkout may have different active builds. Builds sharing a checkout must
serialize where dependency installation or generated output can overlap.

Clone and build do not restart Epicenter or replace open windows. Rust reads
the active build when it constructs an installed app window. Asking to open
the same installation on the same data folder reveals its existing window,
even if that window is pinned to an older build. Reloading it keeps the pinned
build; closing and reopening it constructs a window on the current active
build. Epicenter does not need a startup-only inventory snapshot or a file
watcher to replace running pages. The installed-app list can refresh after an
install action or when the person explicitly requests it.

A successful build does not prove that the page works correctly. A failed
build reports its error and leaves the source available for repair. Earlier
completed builds remain available for recovery, though selecting an older
build does not roll back the app's data or browser storage. No background
fetch starts a build or activates an author's new code without the person's
or agent's update action.

**Installing source is an explicit trust decision, not an account grant.**

The host does not pass Epicenter account tokens to an installed page, a
third-party Git remote, or a build environment. It supplies Epicenter Git
credentials only to Epicenter's Git origin; other remotes use the person's
configured Git helpers. Installed pages receive only the native operations
they need for their admitted data, not the host's account operations. Before
build scripts run, the person or agent can see the source checkout, HEAD, and
whether local edits are included.

A build script still executes as a local process under the person's operating
system account. It can reach files and credentials available to that account,
including by invoking installed command-line tools. Narrow Tauri page
capabilities and a cleaned build environment do not make that process a
sandbox. Epicenter must not claim that it safely runs untrusted source until
a real build and runtime isolation boundary is designed and verified. Source
installation is an explicit action, not an automatic consequence of browsing
a catalog.

## Consequences

- A coding agent can work on an app through ordinary Git commits, merges,
  build commands, and test commands. Epicenter does not need its own merge
  algorithm or conflict editor for app source.
- The first-party monorepo can remain the source of Todos and other apps.
  One checkout exposes their app targets while each build uses the
  repository's lockfile and workspace packages. Building one target does
  not require building every app. Clone, dependency, and build costs still
  need measurement.
- Shallow cloning can reduce the first Git transfer, not the size of the
  current working tree, dependency downloads, or compilation. Agent work
  that needs older history may fetch it on demand.
- A failed build can leave the checkout broken while the last built page
  still opens. This separates an agent's source work from the user's ability
  to use the app; it does not hide build failures.
- Sign-in is optional for public source installation and local edits. It is
  useful for private repositories and for publishing a personal fork. A
  fork by itself does not back up changes; the person's commits must be
  pushed to it.
- Source builds execute code with local process privileges. Per-window Tauri
  grants cannot by themselves protect the account or filesystem from a
  malicious build script. A general public app marketplace requires a
  stronger isolation decision or an honest trust requirement.
- Browser apps keep their separate deployment and data-sync model. They do
  not acquire this source installer by sharing an app's Git repository.
- Source checkouts, built output, and data folders have different lifetimes.
  Removing an installed target cannot erase any of the other two without a
  separate, explicit operation. The first source-installed target can coexist
  with today's fixed bundled apps; replacing those bundles is a later
  decision.
- Completed builds are not automatically deleted in the first implementation.
  An older build may still be serving an open window after a newer build
  becomes active.
  Later cleanup needs to account for open windows and preserve a recovery
  build.
- External repositories can build against Epicenter's app API only after
  that API is distributable. The current `@epicenter/folder` package is
  private, so the first implementation can validate this model in this
  monorepo or a fork without claiming arbitrary third-party compatibility.

## Considered alternatives

- **Copy an app directory out of its repository.** This loses workspace
  dependencies and ordinary upstream Git merge history. It turns source
  installation into an export format with its own update machinery.
- **Require one repository per app or one clone per app.** This duplicates
  a monorepo and hides the fact that shared package changes can affect
  several app builds. A separate checkout remains available when branches
  truly need to diverge.
- **Require every app under `apps/`.** A tracked manifest at each app root
  handles single-app repositories and other monorepo layouts with one rule.
- **Use `git pull` on the working branch for every update.** This combines
  fetching, merging, and checkout mutation before Epicenter can inspect the
  candidate or build it. Explicit fetch, merge, and build steps keep agent
  work visible and make failures easier to repair.
- **Require a successful build before allowing source edits or merges.** This
  would turn a runtime recovery measure into a restriction on development.
  The source may be incomplete while an agent is working on it.
- **Treat page capabilities as a complete account sandbox.** They constrain
  WebView-to-host calls, but they do not constrain the operating system
  process that runs the downloaded build script.
- **Keep editable source in application data.** That would hide the ordinary
  checkout from the person and make it too easy to confuse authored source
  with replaceable host state. Resetting or uninstalling Epicenter could then
  delete unpushed commits, and development and release installations could
  create separate source copies. Application data holds the inventory and
  installed build copies instead.
