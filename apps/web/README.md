# Web shell

One origin for every first-party app. The shell opens a repository from the
URL and shows any first-party app over it: an app is a lens that claims
files by path, so any of them opens any repository. Apps are packages
([`apps/todos`](../todos), [`apps/honeycrisp`](../honeycrisp)) that export
their definition and root component; the shell owns routing, opening, and
storage. Nothing first-party goes around the repository API
([`@epicenter/repository`](../../packages/repository)).

## The model

- **Owners and repositories.** An owner (a person, or an organization with
  equal owners) owns repositories. A repository is the unit of sharing.
- **Addresses.** `/<owner>/<repo>/<app>`, on one origin.
  - `/<owner>/<repo>` is the repository's page: every first-party app, each
    marked when the repository has files it claims (Has data, or No data
    yet), the link that joins it from another browser when it syncs, and
    this browser's other repositories.
  - `/<owner>/<repo>/<app>` is that app over the repository: `todos` or
    `honeycrisp`.
  - Every shell page that is not a repository lives under `/-/`: `/-/storage`
    (this browser's copies) now, later `/-/sign-in`.
  - Owner, repository and app names match `[a-z][a-z0-9-]*`: a letter
    first, so no name can be `-` or `_app` (where the build serves its
    files). The routes accept only such names (`src/params/name.ts`).
  - The same `<owner>/<repo>` names the repository on its server and, later,
    as a Git remote.
- **`me` is you.** Before sign-in it is the person using this device; once
  accounts exist (phase 10), `me` redirects to your owner name. `me` is the
  only reserved owner name. There is no pseudo-owner such as `local`: a
  repository kept only on this device is still yours, at `/me/<repo>`.
- **Home.** Every owner's home repository is named `home`, people and
  organizations alike. `/` and `/me` open `/me/home`, and `/<owner>` opens
  `/<owner>/home`. Your home is made the first time it is used, kept on this
  device until accounts exist. There is no home pointer, no setting that
  picks another home, and no rule of its own for removing it.
- **Apps are lenses.** An app claims folders by content (`todos/`, `notes/`),
  never by its own name, so any first-party app opens any repository, and a
  browser keeps one copy of each repository for all of them.
- **Other apps** are websites that ask for a repository: once the person
  approves, a website is a client of that repository, as an agent or the CLI
  is. None runs on the shell's origin. Not built yet.

## Settings by audience

Settings are layered as Git layers config. Only what the apps need is
built, and neither Todos nor Honeycrisp has settings yet. When one does:

| Audience | Where |
| --- | --- |
| Everyone who shares the repository | A note in the repository: `settings/<app>.md`. |
| You, for one repository | This device's storage; it does not follow you to another device. |
| You, everywhere | A note in your home repository. |
| Secrets | The device only, never a repository. |

An app reads at most the repository it shows and your home for settings;
no setting is kept in your home keyed by another repository's id.

## One handle per open repository

The `[owner=name]/[repo=name]` layout opens the repository the address names once, with
every first-party app's lens together (`lens` in `src/lib/apps.ts`), under
`RepositoryGate` from `@epicenter/svelte`. Moving between that repository's
page and its apps keeps the handle: nothing opens again. Another address
(a link, Back or Forward) closes it and opens that repository instead.
Closing lists any typing that could not be saved, with Copy text, on
whatever page comes next. Two apps that name a collection alike, or whose
templates could claim one file, are refused when the shell loads.

A copy in this browser is a replica in this origin's private storage (OPFS),
owned by one tab's worker; its manifest records whose repository it is
(`owner`, null for you), its id, its name here, the account, and the server.
The shell keeps no list of its own; `src/lib/device.svelte.ts` lists the
manifests.

## Join a synced repository

A repository that syncs shows its join link on its page:
`/<owner>/<repo>?server=<url>`. Opening it in a browser without a copy asks
whom to sync as, then makes this browser's copy bound to that server; once
there is a copy, the address opens it and `server` leaves the URL. The Join
form in Storage takes the same four values. Until accounts exist, whom to
sync as is any name the development server takes as the credential
(`Authorization: Bearer <name>`).

From the repository root:

```sh
bun dev:web
bun packages/repository/scripts/serve.ts /tmp/team.git --repository notes --origin http://127.0.0.1:5190
```

Then open `http://127.0.0.1:5190/team/notes?server=http%3A%2F%2F127.0.0.1%3A8787%2F`,
sync as any name, and open the same link in a second browser profile as
another name. The server commits to `/tmp/team.git` a minute after a change,
so `git clone /tmp/team.git` shows the files.

## Storage

`/-/storage` lists this browser's copies with their addresses and where each
syncs, makes a new repository of yours kept on this device, and joins a
synced one. Remove asks first; a copy with files that have not reached a
server says how many are only in this browser before Remove anyway.

## Layout

| Path | Role |
| --- | --- |
| `src/lib/apps.ts` | The first-party apps (address segment, name, lens, root) and the one lens every repository opens with. |
| `src/lib/device.svelte.ts` | This browser's copies, addresses, `me`, home, create, join and remove. |
| `src/lib/open.svelte.ts` | The open repository's context, and typing left unsaved when it closes. |
| `src/lib/Opened.svelte` | One open repository under the gate. |
| `src/routes/[owner=name]/[repo=name]/` | The layout that opens the repository, its page, and `[app=name]/`. |
| `src/routes/-/storage/` | Storage. |
| `src/lib/name.ts`, `src/params/name.ts` | The name rule, and the route matcher that applies it. |
| `browser-tests/` | Playwright: the shell, Todos, and Honeycrisp, in Chromium and WebKit. |

## Checks

From `apps/web`:

| Command | What it checks |
| --- | --- |
| `bun run typecheck` | The shell and its browser tests. |
| `bun run test` | The bundle: no Yjs, Node or Bun module, and no folder engine. |
| `bun run build` | The static site, into `build/`. |
| `bun run test:browser` | The built site with persistent profiles, one origin per person: home, apps sharing one handle, reload, Back and Forward, Storage, joining by link, and each app's own flows. |
