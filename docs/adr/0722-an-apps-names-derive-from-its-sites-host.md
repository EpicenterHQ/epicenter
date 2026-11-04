# 0722. An app's names derive from its site's host

- **Status:** Accepted (2026-11-03)
- **Date:** 2026-11-03
- **Supersedes:** [ADR-0710](0710-an-apps-slug-names-everything-a-program-reads.md) (an app's slug names everything a program reads): a slug is not unique across owners, so the folder, repository and AppData names come from the host of the app's site instead.
- **Relates:** [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md) (an app is identified by its origin); [ADR-0711](0711-a-folder-names-its-apps-contract-in-a-committed-agents-md-note.md) (a folder's `AGENTS.md` names its contract URL); [ADR-0712](0712-an-apps-folder-resolves-against-a-fixed-library-root.md) (fixed roots); [ADR-0721](0721-an-apps-folder-is-derived-never-stored.md) (an app's folder is derived, never stored); [ADR-0723](0723-an-apps-site-is-found-by-convention.md) (an app's site is found by convention).

## Context

[ADR-0710](0710-an-apps-slug-names-everything-a-program-reads.md) named an
app's folder, repository and AppData directory by its contract `name`, a slug
such as `whispering`. A slug is chosen by the app's developer, so two apps
from different owners can both be `notes`, and they then claim the same
`~/Epicenter/notes`. With the folder always derived from the app
([ADR-0721](0721-an-apps-folder-is-derived-never-stored.md)), no second folder exists to give one of them, and resolving the
clash by install order would give two machines two different trees.

The app's site already carries a unique name: its host. Today the first-party
apps' hosts are subdomains of `epicenter.so`, and Zhongwen, which is not an
Epicenter app, lives at `https://zhongwen.bradenwong.com` with the AppData
identifier `com.bradenwong.zhongwen` (`packages/definition/src/site/apps.ts`).
`APP_NAME` in `packages/definition/src/contract/contract.ts` accepts only
lowercase letters, digits and `-`, so a contract cannot name itself by a host.

## Decision

**An app's identity is its declared production origin.** The origin is the
`https` origin on the default port that the app publishes as its site, for
example `https://whispering.epicenter.so`. Where a build runs
(`http://localhost:5173`, `tauri://localhost`) never names anything.

**Every name a program reads derives from that origin's host.**

| Host | Folder | Repository | AppData |
| --- | --- | --- | --- |
| `whispering.epicenter.so` | `~/Epicenter/whispering` | `<account>/whispering` | `so.epicenter.whispering` |
| `zhongwen.bradenwong.com` | `~/Epicenter/bradenwong.com/zhongwen` | `<account>/zhongwen.bradenwong.com` | `com.bradenwong.zhongwen` |

- **An app at a direct subdomain of `epicenter.so` is named by its label.**
  `whispering.epicenter.so` is `whispering`. Only a direct subdomain shortens:
  `notes.app.epicenter.so` lives in the owner folder `app.epicenter.so/notes`,
  never at `notes.app`.
- **Every other app lives in its owner's folder.** Split off the host's first
  label; the rest names the owner. `zhongwen.bradenwong.com` is the folder
  `zhongwen` inside `~/Epicenter/bradenwong.com/`.
- **At the top of `~/Epicenter`, a name without a dot is one of Epicenter's
  apps, and a name with a dot is an owner's folder.** An owner folder holds
  that owner's app folders and is not a repository; each app folder inside it
  is.

```txt
~/Epicenter/
  capture/                   Epicenter's apps: names without a dot
  vocab/
  whispering/
  bradenwong.com/            an owner: a name with a dot
    invest/
    zhongwen/
```

- **The repository is the label for Epicenter's apps and the full host for
  every other app.** **AppData is the reversed host.**
- **A development build uses the same names under its own roots:**
  `~/Epicenter Dev/whispering`, `~/Epicenter Dev/bradenwong.com/zhongwen`, and
  AppData with `.dev` appended (`so.epicenter.whispering.dev`).
- **A contract has no `name`.** A contract describes what an app's data
  looks like: `description` and `collections`. The app's name comes from its
  site, so a `name` key could only repeat the derived name or disagree with
  it. `openRemote` takes the repository name from the app's site.

**A person's short links are their own.** A person may add
`ln -s bradenwong.com/zhongwen ~/Epicenter/zh`. A link should not take a name
without a dot that Epicenter could later give one of its apps. Epicenter never
writes a link's path into `AGENTS.md` or a note, and its scan treats a link
and the folder it points to as one folder.

**A few hosts do not fit the rule.**

- An app lives on its own subdomain. An app at an apex host
  (`bradenwong.com`) has no first label to split off, and two apps under one
  origin (`user.github.io/a`, `user.github.io/b`) share an identity; neither
  is supported.
- A host whose first label or owner contains a Windows reserved name (`con`,
  `prn`, `aux`, `nul`, `com1` to `com9`, `lpt1` to `lpt9`) is refused.
- An owner domain ending in `.app` makes Finder show the owner folder as an
  application bundle. It opens in Terminal, in agents and through "Show in
  Finder" on the app folder inside it; no escape is applied to the name.

**Moving to a new domain is a new identity.** Its folder, repository, AppData
and grants move only by an explicit migration.

## Consequences

- A second machine computes the same tree from the same origins, with nothing
  stored and no list of apps.
- Epicenter's apps keep the short names they have today; no first-party
  folder, repository or AppData directory changes.
- Zhongwen's AppData already equals its reversed host. Its folder becomes
  `~/Epicenter/bradenwong.com/zhongwen` and its repository
  `<account>/zhongwen.bradenwong.com`.
- An owner's apps sort together, and every name typed in a shell is a short
  label.
- Epicenter's folder scan reads one level deeper, into folders whose names
  contain a dot.
- Rebranding or losing `epicenter.so` would rename every first-party folder.
  A fork that hosts the apps elsewhere gets owner folders for them.
- For a deep subdomain the owner folder is everything after the first label
  (`notes.team.example.com` lives in `team.example.com/notes`), not the
  registered domain; no public suffix list is consulted.

## Considered alternatives

- **The contract's slug ([ADR-0710](0710-an-apps-slug-names-everything-a-program-reads.md)).** Two owners' `notes` collide, and no rule without a list or an install order separates them.
- **Flat names, with Epicenter's apps short** (`~/Epicenter/zhongwen.bradenwong.com`). An owner's apps scatter through the list, and long names crowd it.
- **The full host for every app** (`~/Epicenter/whispering.epicenter.so`). Every path grows, and names sort by their first label, so an owner's apps still scatter.
- **Reverse DNS for every app** (`~/Epicenter/so.epicenter.whispering`). Groups by owner, but every name starts with the same prefix and tab completion stalls on it.
- **Owner folders for Epicenter's apps too** (`~/Epicenter/epicenter.so/whispering`). One rule with no exception, at the cost of a longer path for the apps used most.
- **A configurable home domain, an alias map, or a short name when it is free.** Each depends on stored state or install order, so two machines can compute different folders for one app.

Go uses the same shape: standard library packages have short names
(`fmt`, `net/http`), and every other module is named by its domain path
(`github.com/user/repo`) in imports and in the module cache on disk.
