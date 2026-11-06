# 0811. Folders are shared directly, and an app reaches the folders attached to it

- **Status:** Accepted (2026-11-06)
- **Date:** 2026-11-06
- **Supersedes:** [ADR-0770](0770-teams-own-repositories-and-sharing-is-membership.md) (teams own repositories, and sharing is membership): a folder has members, and no team or space owns it; [ADR-0791](0791-a-folders-first-sync-places-it-in-its-teams-folder.md) (a folder's first sync places it in its team's folder): nothing is moved into a space's directory.
- **Amends:** [ADR-0802](0802-people-share-spaces-an-app-works-in-one-at-a-time-and-a-folder-carries-its-contract.md) at spaces and the space switcher: an app works in one folder at a time, chosen with a folder picker; [ADR-0809](0809-a-repository-is-a-spaces-app-and-bytes-nothing-needs-are-collected-or-purged.md) and [ADR-0810](0810-a-folder-needs-no-app-and-a-repository-is-a-spaces-named-folder.md) at a repository addressed by space and name: it is `/folders/<id>`, and `epicenter.json` holds no `name`; [ADR-0772](0772-a-folder-says-what-it-is-in-agents-md-and-this-computer-keeps-the-rest.md) at two folders claiming one app neither syncing: a first sync joins before it creates, and a copied folder asks before it pushes; [ADR-0732](0732-a-grant-reaches-what-the-person-chooses-at-consent.md) at a grant reaching a team's repository: it reaches the folders attached to the app; [ADR-0805](0805-a-folder-is-recognized-by-epicenter-json-which-is-its-contract.md) at `epicenter.json`'s fields: `$schema`, `$id` when an app owns it, and `collections`.
- **Relates:** [ADR-0804](0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md) (the manifest), [ADR-0806](0806-an-open-app-checks-for-changes-and-a-sync-never-silently-loses-an-edit.md) (an open app checks for changes), [ADR-0790](0790-the-epicenter-app-is-a-library-over-every-folder-and-the-cli-answers-its-queries.md) (the library).
- **Amended by:** [ADR-0812](0812-an-apps-schema-is-a-view-that-must-fit-a-folders-contract.md) at `$id` marking an app that keeps the contract: no app owns it, and there is no `$id`.
- **Amended by:** [ADR-0813](0813-epicenter-is-your-folders-and-apps-are-lenses.md) at `epicenter init` making a folder: it adds a contract to one.
- **Amended by:** [ADR-0814](0814-one-window-shows-one-folder.md) at an app's folder picker: a window shows one folder, and another folder opens in another window.
- **Amended by:** [ADR-0820](0820-a-share-is-an-invitation-to-an-email-and-reaching-every-folder-is-a-permission.md) at sharing, owners, and app reach: a share is an invitation to an email; members are equal, and a reader only reads; `folders:all` reaches every folder, and only it attaches a folder to an app.
- **Amended by:** [ADR-0821](0821-a-computer-remembers-what-it-synced-and-a-shell-limits-each-window-to-its-folder.md) at a copy asking before it pushes and an app reaching its attached folders: a copy stays local with no question, and on the desktop a first-party program reaches every folder the person holds.
- **Amended by:** [ADR-0824](0824-a-folders-history-is-a-log-of-versions-and-git-is-how-it-leaves.md) at `git clone` reaching a folder's history: there is no Git remote; history leaves by `epicenter export --git`.
- **Unbuilt:** sharing managed by person (removing someone from every folder, sharing what another person has); "Use this folder with" an app and the question a copy asks, in a window (the CLI asks with `--new` or `--same`); `epicenter init` converting YAML front matter.

## Context

Spaces made one membership share many folders, but a folder never moved
between spaces, so sharing one existing folder (a reading list, a diary) meant
copying it into a shared space and leaving its history behind. ADR-0810 let
any folder holding `epicenter.json` be a full Epicenter folder, so a person's
own folders became the common case to share. The server already shares one
repository with one person without moving it (`repository_grant`). An
adversarial review of three reviewers agreed on sharing folders directly and
found what it needs to be safe: a folder that would die with its owner's
account, a grant that followed `$id` (content anyone holding the folder can
write), two computers minting two ids for one folder, and a Finder copy of a
shared folder pushing private notes to its members.

## Decision

**A folder is the one thing that is synced and shared.** It has an id, given
by the server at its first sync, and members, who are people. Any member may
be an owner, and a folder lives while any member remains; deleting an account
removes it from its folders and deletes only folders no one else holds. Its
history is a Git repository at `/folders/<id>`.

**A folder's title is in its `epicenter.json`.** `"title"` starts as the
directory's name when the folder is made, is renamed by editing it like any
field, and syncs, works offline, and keeps its history like any change. The
server reads it from the folder's current files for invites and folder
pickers, and keeps no copy. The title is the person's even where an app owns
the contract, since a write changes only the fields it names. A computer's
directory starts with the title and is that person's own label after. Neither
is an identity.

**A person shares a folder with people**, and a share appears in their apps
once they accept it. Sharing is also managed by person: one action removes
someone from every folder shared with them, and one shares with someone the
folders another person has.

**An app reaches the folders attached to it.** The server records the
attachment when an app's first sync creates a folder, or when a person
chooses "Use this folder with" an app, which is how an app adopts a folder
someone made. `$id` in `epicenter.json` describes a folder and authorizes
nothing.

**A first sync joins before it creates.** An app's first sync finds the
folders attached to it that the person holds: with one it joins it, as a first
contact; with several it asks which; with none it creates one. A folder no app
made asks whether it is new or one the person already has.

**A copied folder asks before it pushes.** The manifest is
`{ folder, root, commit, files }`, `root` being the identity of the directory
it was synced in (device and inode, which a move keeps and a copy does not).
When they differ, a sync asks whether this is the same folder or a copy before
it sends anything; a copy becomes a new folder.

**An app shows one folder at a time, with a folder picker** listing each
folder's title and members ("Only you", "You and Jess"). An app that keeps more
than one folder asks for a name when it makes one.

**`epicenter.json` is the contract:**

```json
{
  "$schema": "https://epicenter.so/schema/epicenter.json",
  "$id": "https://todos.epicenter.so/contract.json",
  "title": "Todos",
  "collections": {
    "todos": {
      "path": "todos/{name}.md",
      "fields": { "title": { "type": "string" }, "done": { "type": "boolean" } },
      "required": ["title", "done"]
    }
  }
}
```

`$schema` lets an editor check it. `$id` is present when an app keeps the
contract current, and removing it makes the contract the person's. An
`epicenter.json` with no collections is a complete folder: every visible file
syncs and keeps history, and collections add checking, tables, tools, and
merging by field.

**`epicenter init` makes a folder in one step.** It proposes collections and
fields from the front matter already in the folder, offers to convert other
tools' YAML to `key: <JSON>`, and writes `epicenter.json` and `AGENTS.md`;
`--dry-run` shows the proposal and `--yes` accepts it, for agents. Normalize
stays as one note's repair. `epicenter clone` lists the person's folders by
label and owner; `git clone` reaches a folder's history by its id.

## Consequences

- Sharing an existing folder is one action, and keeps its history.
- A shared folder outlives any one person.
- No content in a folder can extend an app's reach.
- Someone leaving or joining a family is one action across its folders, with no group to keep.
- An app's folders grow when a person accepts a share of a folder attached to
  it.

## Considered alternatives

- **Spaces owning folders:** one membership for many folders, and a folder that
  can be shared only by copying it into a space.
- **A grant that follows `$id`:** no attachment to record, and anyone who can
  write a folder can hand it to another app.
- **Two copies of a folder syncing as two working copies:** no question asked,
  and a copied shared folder pushes private notes to its members.
- **Groups, saved lists of people that folders are shared with:** one edit for
  a family's changes, at the price of an entity, its own membership, and who
  manages it; managing sharing by person does the same in one action.
- **A title kept by the server:** a rename needs the network and leaves the
  folder's history.
