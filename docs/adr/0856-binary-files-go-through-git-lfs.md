# 0856. Binary files go through Git LFS

- **Status:** Proposed
- **Date:** 2026-11-08
- **Relates:** [ADR-0851](0851-each-app-has-one-git-remote-its-meeting-point-and-backup.md) (the remote), [ADR-0852](0852-an-app-is-a-git-repository-of-files-and-actions.md) (the template), [ADR-0853](0853-collections-give-four-actions-and-programs-without-the-folder-ask-over-mcp.md) (byte collections and programs that write files).
- **Unbuilt:** all of it: the template's `.gitattributes`, the check before committing, and `setup`'s check for `git-lfs`.

## Context

Apps keep audio (Whispering's takes), images, and PDFs beside their notes. In
plain Git every version of such a file stays in every clone's history forever,
and GitHub refuses a file over 100 MB. Whispering's Opus audio is small enough
that a year of daily notes is under a gigabyte by estimate, but it, photos, and
attachments all grow without bound.

## Decision

**An app's binary files go through Git LFS, set in its `.gitattributes`.** The
template routes common binary types through LFS:

```txt
*.webm *.m4a *.wav *.mp3 *.png *.jpg *.jpeg *.heic *.gif *.webp *.mp4 *.mov *.pdf
  → filter=lfs diff=lfs merge=lfs -text
```

An app adds or removes patterns in its own `.gitattributes`; nothing else in
Epicenter knows about LFS.

- **A path marked for LFS is never committed without `git-lfs`.** When the
  filter is not installed Git ignores the attribute and stores the whole file,
  without a word. `epicenter`, and any program that commits what it wrote,
  checks `git lfs version` first and fails naming the missing tool instead.
- `epicenter setup` checks for `git` and `git-lfs` and says how to install a
  missing one. Both are the computer's own installations, which hold its
  credentials and configuration.
- A clone may skip downloading LFS files (`lfs.fetchexclude`, or
  `GIT_LFS_SKIP_SMUDGE=1` when cloning) and fetch one when it is opened. Your
  Epicenter fetches everything.

## Consequences

- Text history stays small and diffable; binaries are stored once per version on
  the remote's LFS store.
- The remote must support LFS. GitHub does, metered beyond a free quota; whether
  Cloudflare Artifacts does is to be checked before Epicenter Cloud relies on it.
- No app needs a setting for keeping binaries out of the folder.

## Considered alternatives

- **Binaries in plain Git.** Every version in every clone, and a 100 MB file
  limit on GitHub.
- **Binaries outside the folder, with a setting per app.** A second store beside
  the repository, which nothing moves between computers.
- **LFS for every file.** Text gains nothing and loses its diffs.
