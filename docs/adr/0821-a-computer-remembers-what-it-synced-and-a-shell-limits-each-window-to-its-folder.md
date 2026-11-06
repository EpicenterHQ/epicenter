# 0821. A computer remembers what it synced, and a shell limits each window to its folder

- **Status:** Accepted (2026-11-06)
- **Date:** 2026-11-06
- **Amends:** [ADR-0804](0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md) at the manifest `.epicenter/synced.json` in each folder: the Epicenter folder keeps one record per synced folder; [ADR-0811](0811-folders-are-shared-directly-and-an-app-reaches-the-folders-attached-to-it.md) at "A copied folder asks before it pushes" and "An app reaches the folders attached to it": a copy stays local with no question, and on the desktop a first-party program reaches every folder the person holds; [ADR-0818](0818-an-app-is-a-view-a-window-and-its-capabilities-and-everything-is-repairable-by-hand.md) at "`.epicenter/` is a cache whose loss costs only the next sync's speed": losing a folder's record costs one question and a merge without a base; [ADR-0819](0819-every-program-keeps-the-folders-it-has-open-in-sync-and-the-epicenter-app-has-them-all-open.md) at "an app reaches only the folders attached to it": that holds for web sites and third-party apps; [ADR-0820](0820-a-share-is-an-invitation-to-an-email-and-reaching-every-folder-is-a-permission.md) at `folders:all` belonging to the CLI and the Epicenter app: every first-party desktop program reaches every folder, and consent says so.
- **Relates:** [ADR-0565](0565-a-refresh-token-keeps-its-grants-scopes-and-only-each-access-token-is-narrowed-to-its-audience.md) (a refresh family is every grant of one client for one person), [ADR-0731](0731-every-app-signs-in-as-its-site.md) (each app signs in as its site; a shared keychain item failed), [ADR-0740](0740-every-credential-an-app-holds-lives-in-its-own-place.md) (credentials as files), [ADR-0785](0785-a-desktop-app-signs-in-to-sync-its-own-folder.md) (a desktop app signs in to sync its own folder), [ADR-0732](0732-a-grant-reaches-what-the-person-chooses-at-consent.md) (consent).
- **Unbuilt:** all of it: records and `root.json` at the Epicenter folder's root, the stamp, the matching rules and the batched question, the shell command that writes a window's record, an app finding its folder through its record, a create that never joins and a join that names its app, the guard against mass deletion, importing in-folder manifests, refusing a root inside a file-sync service, finishing a refresh before quitting, the shell's allowlist, consent text, and removing copy detection with `--new` and `--same`.

## Context

A folder's manifest, `.epicenter/synced.json`, sat inside the folder and named
the server folder it syncs with, so a Finder copy, a backup, or a folder handed
to someone carried a claim to push into that folder. Copy detection compared the
directory's device and inode with the manifest and asked "same or new" when they
differed. A move to a new computer changes every device and inode, so every
folder looked like a copy and stopped syncing; an external drive's device
number changes when it remounts; a lost manifest made a second server folder; a
wrong "same" pushed the copy's deletions; and a copy kept the names of notes
deleted before it was handed on. A page could also write its own folder's
manifest.

Three reviewers tested moving this record to the computer, and found that
rebinding by name or by inode alone can push mass deletions: a rename that an
app answers by making an empty folder at the old name, an inode the file system
reuses, a backup restored over newer state. What protects against all of these
is a rule about when the record can be trusted, more than where it lives.

On the desktop, a first-party app runs unsandboxed as the person, reads every
local file, and could read any other app's credential file, so limiting its
server token to attached folders adds little against a compromised app. What
does need a limit is the app's page, which renders notes other people wrote and
reaches the server only through the shell's relay. A shared rotating credential
was rejected: a refresh family is every grant of one client for one person
(ADR-0565), so a refresh cut off by an app quitting would sign every program out
on every computer.

## Decision

**A computer remembers what it synced; a folder holds what it means.** The
Epicenter folder keeps one record per synced folder at
`.epicenter/folders/<id>.json`: `{ folder, name, inode, birthtime, commit,
files }`, and its own identity at `.epicenter/root.json`. Records are named by
folder id, so one directory at most syncs a server folder on a computer. Only
trusted code writes them: the CLI, the Epicenter app, and a shell command
limited to its window's folder. A folder keeps `.epicenter/` for unfinished
saves, the hash cache, recordings in progress, and `agreed`: `{ folder, stamp
}`, the stamp being a digest of its record, which only that shell command
writes.

**What was agreed is trusted only when this directory is proven the one that
agreed it.** A folder is proven when its inode and birth time match its record
(the inode alone where the file system has no birth time) and its stamp matches
the record's digest. Otherwise:

| Situation | Result |
| --- | --- |
| The Epicenter folder itself moved (a new computer, a restored home), and a folder's name and stamp match | the agreed state is kept |
| The Epicenter folder itself moved, and only the name matches | bound silently, from first contact |
| Anything else | unbound |

First contact pulls what is only on the server, pushes what is only here, and
merges what is on both, and never deletes on either side. A folder restored in
place from an older backup carries an older stamp, so it starts from first
contact.

**A folder with no binding stays local until something syncs it.** A Finder
copy is a new local folder, and nothing asks about it. Unbound folders the
person chooses to sync, or that an app makes, go into one question that offers
only folders the person holds that are not bound on this computer, matched by
the hint in `agreed`, by name, or by title, saying which and showing members. A
folder with other members is never joined without the person's confirmation; an
app's folder joins silently only when exactly one attached folder matches, held
by the person alone. Every join names its app, and a create never joins.

**A sync that would push many deletions stops and asks.**

**Each program keeps its own sign-in.** Every app, the CLI, and the Epicenter
app keep their own client and refresh-token family, so a replay signs one
program out (on every computer, by ADR-0565) and never all of them. After the
first sign-in on a computer, which leaves a marker in `~/.epicenter` holding no
secret, each other app signs in with one click. A credential records the
computer it was made on and is dropped on another, so a migrated copy signs in
fresh. A program finishes a refresh in flight before it quits.

**On the desktop, a first-party program reaches every folder the person holds,
and its shell limits each window.** `account_fetch` relays for an app's window
only inference, the sync routes of the folder its record names, and joins for
its app; it refuses any other route by default, and a test holds it to the
server's routes. Members, apps, and listing every folder are relayed only for
the Epicenter app's windows and the CLI. Consent says that a desktop app can
reach every folder the person has. Attachment is data on the desktop (for
joining and Open with) and the grant for web sites and third-party apps, which
the consent page can make.

**The Epicenter folder must not be inside a file-sync service.** Epicenter
refuses to sync one found in known Dropbox, iCloud Drive, OneDrive, Google
Drive, or File Provider locations, and warns when it cannot tell.

## Consequences

- Copying, zipping, or handing on a folder carries no claim to sync and no
  names of deleted notes.
- Moving to a new computer keeps every folder synced without a question.
- A wrong guess about which folder is which can merge or bring back deleted
  files, never delete.
- Signing in once lets every other app on the computer sign in with one click.
- Copy detection, `--new`, `--same`, and `copyOf` go away.
- The shell's allowlist grows with the server's routes.
- A folder syncs only inside the Epicenter folder; one elsewhere joins by a
  link.
