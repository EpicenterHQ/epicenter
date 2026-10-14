# Retire the Rust folder owner

**Date**: 2026-10-15
**Status**: In Progress
**Owner**: Braden; Claude implements on `claude/git-sync`, Codex verifies and integrates

## One sentence

Every desktop folder is opened by the page's TypeScript engine over a directory
the shell grants, and the shell's Rust folder owner, its protocol, and the
desktop adapter that spoke it are deleted.

## Decisions

Settled with the user on 2026-10-15, after two independent design reviews
(both recommended a directory-wide data-path policy, one live editor per
folder, and deleting the owner):

- **The shell guards containment, Git's private state, and Git execution;
  nothing else.** A page writes any data path in its own folder that passes the
  shared path rule. No per-folder file list (`page_files` globs) exists: the
  shell cannot know an app's definition, Sync writes whole files outside
  tables, and file browsers create arbitrary paths.
- **One path rule, shared by TypeScript and Rust.** Refused: an alias of
  `.git` in any segment (case, trailing dots and spaces, ignorable code points,
  `git~1`, NTFS stream forms), `HEAD`, and names that do not survive every
  desktop file system (trailing dot or space, Windows device names, `~digit`
  short names, reserved characters, control characters, ignorables). Allowed:
  leading dots (`.gitignore`, `notes/.md`). One vector file checks both
  languages. Sync refuses an incoming update that names a refused path before
  writing anything.
- **One live editor per folder.** A page-engine scope belongs to one window;
  a second open of the same root is refused. Cross-window snapshot sharing is
  not a promise.
- **Quit:** pages settle their admitted work before they approve; `close()`
  awaits in-flight writes; the shell drains admitted native file and Git
  commands before exit. The owner's drain of a page that approved without
  settling is dropped.
- **External edits:** no watcher. Pages read again on focus and after their
  own commands; conditional saves turn a stale write into a conflict.
- **Incoming-update recovery is dropped** on the desktop (ADR-0531 already
  drops it); the next Sync reconciles.
- **Honeycrisp and Whispering keep their standalone desktop shells**, ported to
  the page engine. Their commit author and remote now come from Git's
  configuration, with the shell's author as the fallback.
- **Installed apps are parked:** the installer, catalog members, admission, and
  installed folders are deleted until a real app needs them, when they return
  with per-app scoping designed in.
- **Whispering audio stays in Git**; LFS remains a later phase.

## Steps

| # | Step | State |
| --- | --- | --- |
| 1 | Shared path rule (TS `pathProblem`, Rust `paths.rs`, vector fixture); incoming Sync refused before any write | next |
| 2 | Plugin: directory-wide write policy in place of `page_files` globs; grant refuses a linked root | |
| 3 | One editor per scope; `close()` awaits in-flight writes; shell drains admitted native commands | |
| 4 | Git lab on the page engine | |
| 5 | Capture on the page engine | |
| 6 | Installed apps parked | |
| 7 | Honeycrisp on the page engine | |
| 8 | Whispering on the page engine | |
| 9 | Owner, owner protocol, desktop adapter, and their tests deleted | |
| 10 | ADR-0531 amended, ADR-0476 superseded, READMEs | |

## Desktop checks still owed

Pending a person or an approved computer-use session (the git-sync collapse's
phase 3 gate covers the first two): Save version and private-remote Sync on a
page-engine folder; `index.lock` contention; quit with a save in flight in
Honeycrisp and Whispering; Whispering recording bytes surviving quit and
reopen; a second open of one root refused; Windows `core.hooksPath` and the fs
plugin under a runtime capability.
