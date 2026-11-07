# 0839. A save is one numbered write, a reset deletes nothing, and Epicenter owns the pages every app links to

- **Status:** Superseded
- **Date:** 2026-11-07
- **Superseded by:** [ADR-0840](0840-epicenter-is-where-one-persons-software-lives-and-the-folder-sync-product-waits.md), the same day: Epicenter became the home of one person's apps and agents, and the folder sync product this record belongs to waits. Read it as that product's design.
- **Amends:** [ADR-0837](0837-the-ledger-is-the-persons-model-folders-the-versions-of-their-files-and-who-may-see-them.md) at each file version having its own sequence number and a version carrying only author and time: versions saved together share one, and a version names its program and may carry a message; [ADR-0836](0836-one-merge-a-cursor-that-carries-its-digest-and-one-grant.md) at a device finding a changed digest: the ledger answers "reset", and a reset deletes nothing on either side; [ADR-0832](0832-a-folder-is-the-directory-epicenter-last-synced-or-epicenter-asks.md) at an unbound directory staying local and at an app's folder joining by name: a directory nothing could be becomes a folder at once; [ADR-0821](0821-a-computer-remembers-what-it-synced-and-a-shell-limits-each-window-to-its-folder.md) and [ADR-0822](0822-only-epicenter-syncs-on-a-computer-and-a-folder-holds-only-its-content.md) at a sync stopping before many deletions: only deletions of content that appears nowhere else are held back; [ADR-0838](0838-git-speaks-to-a-folder-through-a-remote-helper-and-the-cli-speaks-a-persons-verbs.md) at a push landing merged and at the commands: a push lands only when made from the latest version, and `get` covers invitations; [ADR-0817](0817-the-cli-exposes-every-platform-operation-and-an-app-inherits-everything-about-folders.md) at an app placing the platform's history and share pieces: an app links to Epicenter's; [ADR-0827](0827-the-cli-and-mcp-render-one-table-of-operations.md) at every operation being an MCP tool: sharing is not one by default; [ADR-0804](0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md) at a phone app syncing itself: on a phone Epicenter syncs as the system's file provider; [ADR-0797](0797-front-matter-is-a-strict-grammar-and-anything-else-is-body.md) at a header outside the grammar being body and at Normalize: any header a bounded YAML reader accepts is read by key, and every write writes the whole header in the grammar, in the contract's order.
- **Relates:** [ADR-0830](0830-epicenter-sends-a-change-the-moment-it-happens-and-checks-for-others-every-thirty-seconds.md) (when sync runs), [ADR-0835](0835-records-from-0802-to-0834-agree-on-files-a-ledger-and-git-at-the-edges.md) (the register).
- **Unbuilt:** all of it.

## Context

Three reviewers examined the design from its externals, its internals, and its
premises, each first sketching their own from the intent. They kept every
premise and found the weak places where things meet: history could not tell a
save, a restore, or a pushed commit apart; a restored server could still delete
files on devices; renaming a directory of notes tripped the deletion guard; an
idle round re-read and re-hashed every note; a push followed by a pull left a
Git user's branch apart from the folder's; a directory made in Finder never
synced; a web app had no honest way to choose a folder; desktop apps could not
show the history and sharing every app was to place; and an agent's tools
included sharing, which a note could ask it to use.

## Decision

**A save is one numbered write.** Versions saved together share one sequence
number; a restore is one; each commit of a push is one, so a push of five
commits keeps five. A version names the program that wrote it and may carry a
message.

**A reset deletes nothing.** Asked what changed since a cursor, the ledger
answers the changes, or every file when the device is far behind, or every
file with "reset" when the history the cursor names is gone. On a reset a
device drops what it had agreed and deletes nothing, here or there. The answer
to a write says which version it followed, so a sync that pushed needs no
second pass.

**Sync costs follow change.** A round reads only folders whose files the
watcher reported changed, and every folder hourly, on waking, and when the
watcher drops events; a cache of every file's size, time, and hash spares
rereading. Each note's agreed text is kept in
`~/Epicenter/.epicenter/bases/`, a cache, so a merge never waits on how long the
server keeps old bytes.

**Only lost content is held back.** A sync that would delete content appearing
at no other path holds back those deletions and nothing else, and says so;
`epicenter get <folder>` brings the files back and `epicenter sync <folder>
--delete` sends the deletions. A rename never trips it.

**A directory nothing could be is a folder at once.** A new directory in
`~/Epicenter` syncs as a new folder unless a folder the person holds, not
synced on this computer, could be it; then it asks. `epicenter get <folder>`
brings a folder the person holds, accepts an invitation they name, or
reconnects a directory; a bare `epicenter get` reconnects and lists, and
accepts nothing.

**Git sees one history.** A push lands only when made from the folder's latest
version, otherwise Git's "fetch first"; so the commit for every version is the
same in every clone. The Git address names the folder's id. Notes and
`epicenter.json` are plain Git files and other files travel through Git LFS by
the helper.

**Epicenter owns the pages every app links to.** A web app opens a folder
through Epicenter's sign-in page, where Open, New, and consent are one screen,
and the token names the folder chosen (OAuth rich authorization requests). In
any app, History and Share open Epicenter's window: a link on a computer, a
page on the web. A desktop app's token reaches only hosted AI.

**An agent's tools leave out sharing** unless the person allows it; each tool
says whether it only reads or can destroy, and a tool reaching every folder
takes the folder by name.

**A header is read as written and written one way.** Epicenter reads any
header a bounded YAML reader accepts, by its top-level keys, so a note another
tool wrote keeps its fields. Whenever a program writes a note's fields, it
writes the whole header in one form: the contract's fields in the contract's
order, then fields the contract does not name in their existing order, each as
one `key: <JSON>` line. The same fields are then the same bytes on every
device, and a merge writes the same form. A header the reader cannot read
merges by line, and the note says its fields cannot be read. There is no format
command.

**On a phone, Epicenter is the system's file provider**, and apps open folders
through the system's document picker.

**Smaller rules.** A conflict's two sides are labelled with names and times in
the ledger's order. `--at` takes the number history prints. `epicenter login`
signs in. `restore` with no moment brings back the version before. An app reads
a note's conflicts as data. `defineView` takes the app's name. A person reads
"paragraph" where the code says "line". Every version is kept, and a person can
take everything, any time, as files or as Git.

## Consequences

- History shows each save, restore, and pushed commit, with the program that
  made it.
- A server restore costs devices only a merge.
- Moving notes never asks about deletions, and a deliberate mass deletion waits
  for one command.
- `git pull` after `git push` is a fast-forward in every clone.
- Apps write no folder picker, history panel, or share sheet.
