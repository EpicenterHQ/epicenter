# 0642. Each desktop app selects its CLI independently of the terminal

- **Status:** Accepted
- **Date:** 2026-10-19
- **Amends:** [ADR-0558](0558-the-epicenter-cli-groups-only-its-app-and-auth-commands.md) only at the requirement that the bundled executable is also the public command: desktop apps use matched private copies; terminal installation is explicit and independently selected.
- **Relates:** [ADR-0633](0633-apps-open-local-data-before-connecting-services.md) (native Git through the CLI), [ADR-0634](0634-hosted-inference-is-independent-of-repository-sync.md) (independent services), and [ADR-0635](0635-generic-desktop-data-tools-are-deferred.md) (standalone delivery).
- **Unbuilt:** standalone private-CLI packaging, explicit-only public-command installation and repair, credential-helper migration, and verification of shared preferences, saves, and any shared credential state across versions. Independent CLI distribution is separate delivery work.

## Context

The current Epicenter desktop app already invokes its bundled `epicenter-cli`
by its exact bundle path. It also runs `install-command` at launch, repointing
`~/.local/bin/epicenter` at that copy. Two app copies can therefore compete to
select the terminal version even though neither needs the public link to run.
The original launch-time behavior came from the superseded ADR-0556 platform.

Device login currently configures Git's credential helper through that public
link. Making terminal installation optional must account for this reference;
changing the launch hook alone would leave an assumed helper address.

## Decision

**A desktop app that needs the CLI runs its matched private bundled executable.**
It resolves the executable relative to its own installed bundle and invokes that
exact path. It does not substitute an executable found on `PATH`, discover the
newest installed CLI, or require Epicenter desktop to be installed or running.
An app that needs no CLI operation need not bundle one.

Native Git remains in the shared CLI implementation. This does not introduce
another native history engine or require app data, Git sync, and inference to
share a service connection.

**Installing the public terminal command is an explicit choice.**
The existing `install-command` operation can select a bundle's CLI through the
public `~/.local/bin/epicenter` symlink. Ordinary application launches do not
create, repoint, or repair that selection. The installer preserves unrelated
regular files and refuses temporary bundle locations that cannot provide a
lasting target, including macOS App Translocation copies.

An independently installed CLI may coexist with private bundle copies. `PATH`
selects terminal invocations only; private app invocations retain their matched
copy. A separate CLI distribution and updater are not prerequisites for an
explicit terminal link to a bundle.

| Event | Result |
| --- | --- |
| Update a selected bundle in place | Its app and private CLI update together; the terminal link still selects that location. |
| Launch a different app or release copy | The public terminal selection stays unchanged. |
| Move or delete the selected bundle | Its public link may break. Explicit installation from the desired copy repairs the link. |
| Update an independent CLI installation | That installation updates through its own installer; desktop apps keep their private copies. |

**Git authentication follows the selected public executable without making apps depend on it.**
A private CLI supplies hosted credentials to the Git operations it runs through
its own authorized invocation. It needs no public terminal shortcut. Configuring
ordinary terminal Git to invoke Epicenter's credential helper must use an
explicitly installed public executable, not an assumed link or an arbitrary
private bundle path.

The command-installation flow must account for existing Epicenter-managed helper
references when choosing or repairing that executable. A bundle-linked public
command makes terminal Git authentication depend on that bundle's location too;
moving it can break both until the explicit link is repaired. Signing in alone
must not silently repoint the public command.

**A private executable does not create a new credential or synchronization identity.**
Executable selection and authorization remain separate. Bundling the CLI does
not grant access to another app's session. Any clients sharing one rotating
refresh token must share its keychain identity, refresh-lock location, and a
compatible refresh protocol. Per-app data-directory overrides must not give
one token different locks. Standalone auth integration must establish those
boundaries before sharing a grant; this record makes no shared-sign-in promise.

Multiple CLI versions may still touch the same preference files or data folder.
Their format and cooperative save protocols must interoperate, or report an
unsupported operation without rewriting state they cannot preserve. Matching a
private CLI to its app does not establish cross-client compatibility.

## Consequences

- Desktop-only use works without installing a terminal command. Headless use
  need not depend on a running GUI; independent distribution can follow when
  delivered.
- Several private copies are acceptable. There is one explicit public terminal
  selection, rather than a machine-wide version-discovery service.
- The person owns repair after moving a bundle selected for terminal use.
  Automatic launch-time repair disappears; safe explicit-installer guards remain.
- Updating two apps can leave different CLI versions operating on one folder.
  Shared-state compatibility remains verification work, not a benefit implied
  by packaging.
- This decision changes executable ownership and installation. It does not
  redesign account grants, inference, native recording, or Git merge behavior.

## Considered alternatives

- **Use whichever CLI is on `PATH`.** Lets a terminal installation change app
  behavior without updating that app and makes GUI-only use require setup.
- **Repoint the terminal command on every launch.** Lets the last launched app
  choose the terminal version and interfere with an independent installation.
- **Require a separately installed CLI for every native app.** Adds another
  install and update channel before the app can start using native Git.
- **Remove CLI use from standalone apps.** Requires another native history
  integration where the shared CLI already supplies it.
- **Promise one shared binary or one shared sign-in.** Executable copies and
  authorization state have different compatibility and lifetime requirements.
