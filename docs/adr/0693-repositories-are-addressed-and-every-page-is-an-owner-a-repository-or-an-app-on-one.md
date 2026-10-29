# 0693. Repositories are addressed, and every page is an owner, a repository, or an app on one

- **Status:** Proposed
- **Date:** 2026-10-29
- **Would supersede:** [ADR-0686](0686-one-https-site-is-one-portable-release-and-one-data-area.md) at "one data area" per site: an app's data is the repository it is opened on, not an area derived from its hostname.
- **Revisits:** [ADR-0687](0687-opening-a-site-url-opens-its-derived-folder.md), for the same reason.
- **Relates:** [ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md), whose owner namespace this keeps; [ADR-0694](0694-installing-an-app-is-trusting-it.md) (what an app is); [ADR-0695](0695-one-sync-engine-runs-on-every-device-and-a-folder-on-disk-is-its-watched-projection.md) (how devices sync).
- **Unbuilt:** accounts, organizations, grants, redirects on rename and transfer. The web shell (`apps/web`) routes `/me/home` and `/<owner>/<repo>` on one origin today.

## Context

Each app chose its repository with a picker and remembered the choice in
private state: a second router the browser could not see. It produced a
remembered repository that trapped the person, tabs silently on different
repositories, and a leave flow. Apps also kept separate copies of data that
one repository could hold, since apps' folders do not collide.

## Decision

**A repository is a folder of Markdown files with history, owned by a person
or an organization, and it is the unit of sharing.** Everyone it is shared with
sees all of it, at their role. An organization has equal owners (at least one)
and members; a repository may grant more people, never fewer. Access is the
higher of the two roles. A smaller audience is a different owner.

**One address everywhere: `<owner>/<repo>`.** The same name is the web
address (`epicenter.so/wong/home`), the Git remote (`epicenter.so/wong/home.git`)
and the server's name for it. Names are shown and stored ids sit beneath them;
a rename or transfer leaves a redirect. Owner, repository and app names start
with a letter.

**Every owner has a home repository named `home`,** created when first used.
**`me` in a URL means you**: before sign-in, this device's person; after,
it redirects to your owner name. `me` is the only reserved name.

**Every page is an owner, a repository, or an app on a repository.**

```
epicenter.so/me                                  you: repositories, installed apps, storage, account
epicenter.so/wong                                an owner: its repositories (members, for owners)
epicenter.so/wong/home                           a repository: its apps and settings
epicenter.so/wong/home/honeycrisp.epicenter.so/notes/pasta   an app on it; the rest is the app's
```

`/` opens `/me`. The repository page lists the person's installed apps that
have data in it, plus Files; nothing records which apps a repository uses.

**Settings are data.** Shared settings are a collection an app declares in
the repository; a person's settings for one repository stay on the device; a
person's settings everywhere are a note in their home; secrets stay on the
device, never in a repository.

**Losing access stops syncing and deletes nothing,** as a Git clone outlives
its remote; the device's copy stays, with a Remove action.

## Consequences

- Switching repositories is navigation. History, bookmarks, tabs and reload
  need no app code; the per-app chooser is deleted.
- One copy of each repository per browser, shared by every installed app.
- Every installed app can read every repository stored in that browser
  ([ADR-0694](0694-installing-an-app-is-trusting-it.md) makes that the trust
  decision).
- A person's per-repository preferences do not follow them to another device.
- `home` cannot name another repository; nobody can take `me` as a name.
- Data a person once had stays on their devices after access ends.
- Guest sessions (a server session with no account) have no remaining caller,
  since `me/home` works with no account; they are to be removed.

## Considered alternatives

- **A picker in each app** (built, then deleted): private routing state.
- **One origin per owner** (`wong.epicenter.so`): browser-enforced separation,
  at the cost of a sign-in per origin, a home for local work, and a download
  on transfer; first-party apps gain nothing from it.
- **A home pointer on the account:** needed a setting and a delete rule.
- **`~` as the alias:** a path on disk but an alias in a URL.
- **`/-/` for system pages:** one reserved prefix inside every repository's
  URL space; pages about you live on `/me` instead.
- **A URL that names data and opens in a default app per folder** ("Open
  with"): apps span folders, so an app that reads several had no address.
- **Personal settings for a repository kept in your home, keyed by its id:**
  made apps read two repositories for settings alone.
