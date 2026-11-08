# 0856. Binary files go through Git LFS

- **Status:** Proposed
- **Date:** 2026-11-08
- **Relates:** [ADR-0851](0851-an-app-with-history-has-one-git-remote-its-meeting-point-and-backup.md) (the remote), [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (the template, and the rule of least power), [ADR-0853](0853-collections-give-four-actions-and-programs-without-the-folder-ask-over-mcp.md) (byte collections and programs that write files).
- **Unbuilt:** all of it: the template's `.gitattributes`, the check before committing, `setup`'s check for `git-lfs`, and the Epicenter API's LFS endpoint on R2.

## Context

Apps keep audio (Whispering's takes), images, and PDFs beside their notes. In
plain Git every version of such a file stays in every clone's history forever,
and GitHub refuses a file over 100 MB. Moving files into LFS after they are
committed (`git lfs migrate`) rewrites history, so every copy must be cloned
again. Cloudflare Artifacts, which holds Epicenter Cloud's repositories, does
not serve LFS.

## Decision

**Text is history; binaries are content.** A note changes, and its history is
worth keeping line by line. A take's audio is written once and never changes; it
only needs storing and fetching by its hash. Git LFS keeps the second kind out of
every clone: history holds a pointer, the bytes live in a store, and a clone
fetches them when they are opened.

**LFS is on from an app's first commit.** The template's `.gitattributes`, and
the one Whispering writes, route binary types through it:

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
| Never committing a binary into plain history | every program that commits: it refuses a path marked for LFS when `git lfs version` fails, because Git without the filter ignores the attribute and stores the whole file |

**Epicenter Cloud serves LFS from R2 through the Epicenter API.** When it creates
an `origin` on Cloudflare Artifacts, it commits a `.lfsconfig` pointing LFS at
`https://api.epicenter.so/lfs/<repository>`, which answers Git LFS's batch API
with signed R2 links, as a hosted feature in `apps/api`. A GitHub `origin` uses
GitHub's LFS.

A clone may skip downloading LFS files (`lfs.fetchexclude`, or
`GIT_LFS_SKIP_SMUDGE=1` when cloning) and fetch one when it is opened. Your
Epicenter fetches everything.

## Consequences

- Text history stays small and diffable; each version of a binary is stored once
  on the remote's LFS store.
- Every computer with a clone needs `git-lfs`, and `setup` checks for it.
- GitHub's LFS is metered beyond a free quota.
- No app needs a setting for keeping binaries out of its folder.

## Considered alternatives

- **Binaries in plain Git.** Every version in every clone, and a 100 MB file
  limit on GitHub.
- **LFS later, when a repository grows.** Migrating rewrites history.
- **Binaries outside the folder, with a setting per app.** A second store beside
  the repository, which nothing moves between computers.
- **LFS for every file.** Text gains nothing and loses its diffs.
