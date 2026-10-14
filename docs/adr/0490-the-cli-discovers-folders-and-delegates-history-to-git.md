# 0490. The CLI discovers folders and delegates history to Git

- **Status:** Proposed
- **Date:** 2026-10-02
- **Implemented:** nothing. The uncommitted Local discovery, Git passthrough, and source CLI `login`, `accounts`, and `logout` were removed before landing; ADR-0520 and ADR-0521 replace them.
- **Unbuilt:** hosted callback deployment, real OS credential acceptance, account-folder discovery, hosted Git credentials, `get`, and `create`. Account folder and transfer examples below remain proposals.

## Context

A fresh laptop can discover account folders and download one, or start editing a selected account folder locally before cloud setup. Once that directory is a Git repository, Git already supplies status, staging, commits, transfers, history inspection, integrity checks, and reconciliation. Separate Epicenter versions of those commands would introduce another semantic surface for the same repository.

Standalone applications such as Whispering still need their own download and upload controls. They cannot depend on the CLI being installed.

## Decision

**Epicenter handles account setup and folder selection; Git handles repository operations.** The proposed account command surface is:

| Command | Effect |
| --- | --- |
| `epicenter login`, `epicenter logout` | Start or end this tool's session; transfer no folder content. |
| `epicenter folders` | Compare the account's live repository listing with local directories and their origins. |
| `epicenter get <folder-id>` | Clone the selected repository into its expected absent directory. |
| `epicenter create <folder-id>` | Explicitly allocate an empty private GitHub repository, pair its repository ID with the folder, and report its current URL. |
| `epicenter git <folder-id> <git-arguments...>` | Resolve and lock the directory, then invoke Git there. |

`--account` selects the session and is required when more than one account is signed in. `--root` selects a root other than `~/Epicenter`. Epicenter options precede `git`; the explicit folder ID precedes all Git arguments. Account folders follow [ADR-0461](0461-an-account-directory-name-is-a-hash-of-the-exact-account-identity.md). An arbitrary or moved clone can be operated on through raw Git at its explicit path; it is not silently registered.

**`folders` derives presence rather than storing installations.** The cloud listing comes from [ADR-0488](0488-cloud-folders-use-independent-git-histories.md). Local entries come from immediate child directories of the selected account root. Local scope entries are shown separately and have no expected account remote. For an account folder, report cloud presence, local directory presence, and configured origin agreement as separate facts:

```text
Proposed output.

Folder                    Cloud    Device       Origin
so.epicenter.whispering    present  directory    matches
so.epicenter.notes         present  absent       none
so.epicenter.todos         present  directory    differs
so.epicenter.archive       absent   directory    configured
```

A directory without a usable Git repository is still a found directory, not an installed app or a healthy clone. Offline, cloud presence and current origin agreement are unknown; any cached observation is labeled with its age. A matching origin proves neither ancestry nor integrity. Listing verifies the native layout before reading configuration, executes no repository hooks, contacts no configured origins, and performs no repair. It ignores dot-prefixed staging and non-folder-ID names. Matching compares the configured origin URL against the canonical service URL, not its spelling after Git rewrite rules; configured push URLs are reported separately because they may send pushes elsewhere.

**`get` restores; `create` allocates a destination.** Get uses staged download and no-clobber publication from [ADR-0489](0489-cloud-folder-transfers-are-explicit-and-bootstrap-before-opening.md), including explicit local `main` setup for an empty repository. An existing directory is reported and never overwritten or retargeted. Create requires an available cloud folder name and leaves any local folder unchanged. It reports the allocated URL; setting origin is an explicit Git operation. Retrying must not silently allocate a second repository for the same folder. With no local data yet, get can install the empty repository. With local data already saved, configure origin and then fetch, reconcile if needed, and push.

**The Git command is a passthrough with an initial selected directory.** Forward arguments as a process argument vector, not shell text. Inherit interactive standard input and output and preserve Git's exit code. Bind the initial Git directory and worktree explicitly to the selected canonical paths, scrub inherited repository-location variables, and acquire the folder ownership lock. Reject direct global selection flags `-C`, `--bare`, `--git-dir`, and `--work-tree`; leave remaining command semantics to Git. Explicit worktree selection overrides `core.worktree` configuration ([Git options](https://git-scm.com/docs/git)). Aliases, hooks, submodules, and subprocesses are ordinary executable Git behavior outside the initial-target coordination guarantee. The CLI does not claim to sandbox them or lock every path they touch. The current engine runner pipes output and disables prompts, so it cannot be reused unchanged for this interactive command.

The Local milestone is runnable from the repository root:

```sh
bun run epicenter --local folders
bun run epicenter --local git so.epicenter.notes status
bun run epicenter --local git so.epicenter.notes init
bun run epicenter --local git so.epicenter.notes add notes/n8.md
bun run epicenter --local git so.epicenter.notes commit -m "Update note"
```

These commands operate on an existing `~/Epicenter/<folder-id>` directory ([ADR-0532](0532-a-folder-is-the-directory-its-id-names-with-its-remote-in-git-configuration.md)). `--root` can select another Epicenter root. Discovery takes no lock, creates nothing, and reads no Git configuration. Its `git: directory` observation means only that a `.git` directory exists; it does not certify repository health. Git initialization is an explicit Git command and retains Git's configured default branch. No remote is required. Inherited `GIT_CONFIG` is cleared because it selects a configuration file directly; ordinary runtime configuration overrides remain available.

The CLI forwards SIGINT, SIGTERM, and SIGHUP and keeps the lock until the direct Git child exits. SIGKILL or SIGQUIT can terminate the CLI while Git survives. Detached descendants, including background Git maintenance, can outlive that child and are outside the lock's lifetime. This is cooperative ownership coordination, not a process sandbox.

The captured Epicenter session authenticates requests to the Epicenter API. After checking the folder pairing, repository ID, and installation access, that API supplies a short-lived GitHub credential for the selected repository. An invocation-scoped mechanism supplies that credential only to the verified GitHub destination, without leaving a persistent helper in the repository or globally installing one. Isolate it from repository-configured helpers and scope it to the actual request destination after rewrites. A mismatching origin is reported by discovery; Git passthrough does not automatically retarget it. The credential implementation must satisfy ADR-0488's feasibility gate before these commands ship. Raw Git network commands need separately configured authentication; the Epicenter session does not automatically authenticate them.

There are no separate Epicenter commit, push, pull, status, doctor, publish, sync, or connect commands. Git's command distinctions remain intact: commit records local history, push transfers commits, and fetch updates the remote observation. Integrity inspection can use `git fsck`; it is not a prerequisite for every folder listing. A person or coding agent can explicitly merge diverged histories with Git. Epicenter neither hides these operations nor implements another conflict workflow.

**A fresh laptop uses this path.**

```sh
# Proposed commands, not implemented.
epicenter login
epicenter folders
epicenter get so.epicenter.notes
epicenter git so.epicenter.notes status

# Edit a file, then record and upload it.
epicenter git so.epicenter.notes add notes/n8.md
epicenter git so.epicenter.notes commit -m "Update note"
epicenter git so.epicenter.notes push

# Observe and adopt incoming history using Git's chosen policy.
epicenter git so.epicenter.notes fetch
epicenter git so.epicenter.notes merge --ff-only origin/main
```

**A person who recorded before cloud setup uses the existing repository.** The following account commands remain proposed. The folder engine already initialized local `main`; setup does not create another history or replace `.git`.

```sh
# Fully exit Whispering before wrapped Git operations.
epicenter folders
epicenter git so.epicenter.whispering status

# Preserve any outstanding authored files before merging.
# Stage selected data paths, inspect them, and commit if needed.

# Use the current URL of the repository ID verified by account discovery.
# Add origin only when absent; inspect an existing origin before changing it.
epicenter git so.epicenter.whispering remote add origin <repository-url>
epicenter git so.epicenter.whispering fetch origin
epicenter git so.epicenter.whispering log --graph --oneline --all

# For independently started histories, explicitly permit joining them.
epicenter git so.epicenter.whispering merge --allow-unrelated-histories origin/main

# Resolve conflicts, finish the merge, and inspect the recordings before pushing.
epicenter git so.epicenter.whispering push -u origin main
```

This is a reconciliation example, not an automatic recipe for every folder. Related history may fast-forward or need a regular merge; an empty cloud repository has no incoming commit to merge. Git requires a configured author for new commits. A conflict can be completed or aborted through ordinary Git commands. Neither merge success nor abort protects ignored bytes that Git already replaced. The passthrough preserves Git semantics rather than adding a no-data-loss guarantee. An app offering managed reconciliation would need the stronger checks in ADR-0489.

Get remains an absent-directory operation. It refuses an existing directory even if that directory has no commits. A pristine existing account folder uses guarded in-place adoption; a folder with local data preserves and reconciles it. No separate `epicenter connect` command, clone-and-swap operation, or local installation record is added.

Applications can instead present Download folder and an explicit Sync action through shared setup and transport code. Sync saves, records, fetches, combines histories, and uploads under ADR-0489's application policy; it can join unrelated roots and must expose conflicts. The existing `folder.git` mechanisms provide parts of this journey, not the completed managed action. Automatic local history remains separate from explicit outgoing publication. Account folder setup, hosted Git credentials, and managed reconciliation remain unbuilt. Signing in reports a derived account path without downloading or configuring a remote.

## Private account sessions

The source CLI's session owner, recorded in a since-deleted ADR-0492, was removed before landing (ADR-0521). Login, cached account listing, and logout do not require a cloud repository listing. The account-key function belongs to `@epicenter/principal`; account paths use its exact-byte contract from ADR-0461.

The CLI binds `http://127.0.0.1:39132/_epicenter/cli/callback` before opening the browser. This callback is separate from desktop development's default port. The hosted allowlist source admits the exact destination. Hosted login requires deployment of that change; this implementation does not deploy it.

The next remote wave proves GitHub App connection, private repository creation, repository-ID-based folder pairing, and captured-account Git transfers under ADR-0488. Account directory selection, origin-based app opening, discovery, and staged get then consume that proof. Existing-folder reconciliation remains explicit Git; it does not wait for an app-owned merge engine. Browser transport and history reconciliation remain separate from the native Git passthrough.

## Consequences

- The CLI adds discovery, directory selection, authentication, and ownership coordination. Git retains its own operations and failures.
- Folder setup stays human-oriented; advanced operations use the vocabulary already available to coding agents and Git tools.
- Every passthrough call refuses while an application owns the folder, including status and log. Close the application, use its controls, or run raw Git with Git's own concurrency guarantees.
- Git status reports local files and refs, not current cloud state. Fetch refreshes remote refs. Neither a clean working tree nor matching origin means all current saved data is in the cloud.
- Git commands can explicitly merge, rebase, restore, or change a remote. Their consequences are ordinary Git behavior, not Epicenter repair or adoption policy.
- Get is not required for local account editing. Creating a cloud destination and configuring origin later do not guarantee that existing histories agree.

## Considered alternatives

- **Separate Epicenter wrappers for each Git operation.** They can provide tailored messages, but require maintaining another operation and outcome model. Apps can own friendly controls without duplicating the CLI surface.
- **Only raw Git.** It works once a repository is set up, but leaves account discovery, directory placement, and hosted credentials to each person or tool.
- **Automatic get for every folder on login.** It downloads unwanted history, including audio, and makes authentication trigger content transfer.
- **One CLI sync command.** It duplicates the staging, commit, merge, and upload operations that the passthrough already exposes. An application's explicit Sync control can own a save-and-refresh policy for its editor without adding a CLI command.
