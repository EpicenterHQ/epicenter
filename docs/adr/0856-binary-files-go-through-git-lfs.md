# 0856. Binary files go through Git LFS

- **Status:** Proposed
- **Date:** 2026-11-08
- **Relates:** [ADR-0851](0851-an-app-with-history-has-one-git-remote-its-meeting-point-and-backup.md) (the remote), [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (the template, and the rule of least power), [ADR-0853](0853-collections-give-four-actions-and-programs-without-the-folder-ask-over-mcp.md) (byte collections and programs that write files), [ADR-0858](0858-where-a-file-lives-decides-whether-it-travels-survives-or-dies-with-its-program.md) (a binary kept on one computer is a `.local` path).
- **Unbuilt:** `setup`'s check for `git-lfs` and the vault's `.gitattributes`. The Epicenter API's LFS endpoint on R2 comes with Epicenter Cloud. Built 2026-11-09: the refusal, before the write lands, of a path marked for LFS when `git-lfs` is not on `PATH` or its filter is not set up, since Git without the filter stores the whole file.

## Context

Apps keep audio (Whispering's recordings), images, and PDFs beside their notes. In
plain Git every version of such a file stays in every clone's history forever,
and GitHub refuses a file over 100 MB. Moving files into LFS after they are
committed (`git lfs migrate`) rewrites history, so every copy must be cloned
again. The vault has 9.1 GB of history, no `.gitattributes`, and a `.gitignore`
that keeps large media out of Git. Cloudflare Artifacts, planned to hold Epicenter
Cloud's repositories, does not serve LFS, by the author's account.

## Decision

**Text is history; binaries are content.** A note changes, and its history is
worth keeping line by line. A take's audio is written once and never changes; it
only needs storing and fetching by its hash. Git LFS keeps the second kind out of
every clone: history holds a pointer, the bytes live in a store, and a clone
fetches them when they are opened.

**A binary a folder tracks goes through LFS; the folder's `.gitignore` still
decides what is tracked.** A folder that holds binaries routes their types
through LFS in its own `.gitattributes`: the one Whispering writes, and one
added to the vault. The template of `epicenter new` has none, since most apps
hold only text and a `.gitattributes` there made every commit on a computer
without LFS fail (amended 2026-11-10). The lines are:

```txt
*.webm *.m4a *.wav *.mp3 *.png *.jpg *.jpeg *.heic *.gif *.webp *.mp4 *.mov *.pdf
  → filter=lfs diff=lfs merge=lfs -text
```

Each job has the owner Git already gives it; nothing in Epicenter sets LFS up.

| Job | Owner |
| --- | --- |
| Which files go through LFS | the folder's `.gitattributes`, written by its author |
| Installing the filter | each computer, once; `epicenter setup` checks for `git-lfs` and says how to install it |
| Where the bytes are stored | the `origin` host, or a `.lfsconfig` naming another server |
| Never committing a binary into plain history | every program that commits: it refuses to commit when `.gitattributes` marks a path for LFS and this computer has no LFS filter, because Git without the filter ignores the attribute and stores the whole file |

**Rewriting a folder's existing history into LFS is the author's choice, made
separately.** For the vault it means measuring the media in its 9.1 GB and the
LFS quota it would use, running `git lfs migrate import`, force-pushing GitHub's
copy with the author's approval, and cloning every copy again. Media the vault
keeps out of Git today could then be tracked, and backed up, through LFS.

**Epicenter Cloud will serve LFS from R2 through the Epicenter API.** When it
creates an `origin` on Cloudflare Artifacts, it commits a `.lfsconfig` pointing
LFS at `https://api.epicenter.so/lfs/<repository>`, which answers Git LFS's batch
API with signed R2 links, as a hosted feature in `apps/api`. A GitHub `origin`
uses GitHub's LFS. Before Epicenter Cloud relies on it, plain Git with partial
clone (`--filter=blob:limit=…`) is checked as the less powerful alternative.

A clone may skip downloading LFS files (`lfs.fetchexclude`, or
`GIT_LFS_SKIP_SMUDGE=1` when cloning) and fetch one when it is opened. Your
Epicenter fetches everything.

## Consequences

- Text history stays small and diffable; each version of a binary is stored once
  on the remote's LFS store.
- Every computer with a clone needs `git-lfs`, and `setup` checks for it.
- GitHub's LFS is metered beyond a free quota.
- No app needs a setting for keeping binaries out of its folder. A binary kept
  on one computer stays in the folder under a `.local` name, which the template
  ignores (ADR-0858); Whispering's "Keep audio on this Mac only" chooses that
  name for future recordings.

## Considered alternatives

- **Binaries in plain Git.** Every version in every clone, and a 100 MB file
  limit on GitHub.
- **LFS later, when a repository grows.** Migrating rewrites history.
- **An exception for the vault.** Two rules for binaries; adding `.gitattributes`
  makes the vault follow the one rule without rewriting anything.
- **Binaries outside the folder, with a setting per app.** A second store beside
  the repository, which nothing moves between computers.
- **LFS for every file.** Text gains nothing and loses its diffs.
