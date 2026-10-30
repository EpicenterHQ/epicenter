# Web shell

One origin where a person's installed apps run over any repository in this
browser. The shell owns the URL, history, the open repository, the
installed apps and storage. An app owns everything after its hostname
segment. Pages and addresses follow
[ADR-0693](../../docs/adr/0693-repositories-are-addressed-and-every-page-is-an-owner-a-repository-or-an-app-on-one.md).
Apps, their contract and installation follow
[ADR-0694](../../docs/adr/0694-installing-an-app-is-trusting-it.md); the
contract itself is [`@epicenter/app`](../../packages/app). Nothing goes
around the repository API ([`@epicenter/repository`](../../packages/repository)).

## Pages

| Address | Page |
| --- | --- |
| `/` | Opens `/me`. |
| `/me` | You. It lists your repositories in this browser (Home first, made when first opened) and your installed apps. It also has Storage (every copy in this browser, with Remove; a new repository; Join), and Account, which is not built yet. |
| `/<owner>` | That owner's repositories in this browser. |
| `/<owner>/<repo>` | The repository. It lists the installed apps with data in it, plus Files, and offers the other installed apps to start there. It also shows where this copy syncs, with its join link. All of this is derived from its files each time: nothing records which apps a repository uses. |
| `/<owner>/<repo>/<hostname>/<...path>` | The app installed at that hostname, over the repository. The rest of the address is the app's path. A bar above it names the repository (its page is one click away) and where its files stand. |

- An owner or repository name is `[a-z][a-z0-9-]*` (`src/lib/name.ts`). An
  app segment must be a hostname (`isHostname`, `src/params/hostname.ts`).
  No name has a dot, so the third segment is always an app.
- `me` is you: the person using this browser until accounts exist. Your home
  is `me/home`.
- A link naming an app that is not installed shows **Install `<hostname>`**
  and **Open in Files**, which opens the same path in Files. Only the
  bundles this shell carries install yet.
- Any other address is a not-found page (`src/routes/+error.svelte`).

## Apps are bundles

An app is a manifest and a module with `mount(element, { repo, path,
navigate })`. The shell carries the first-party bundles: Files, Todos and
Honeycrisp (`src/lib/catalog.ts`). Each manifest is read without loading the
app, and each module loads, as a chunk of its own, the first time the app
is mounted (`src/lib/AppHost.svelte`). `navigate` moves the URL. A URL that
changes under the app is `setPath`, or a fresh mount for an app without
one. Each app brings its own tooltip, dialog and toast providers
(`@epicenter/svelte/app`), so the shell renders none of them.

## Installed apps

The installed apps are a record in this browser's `localStorage`, which
only the person changes (`src/lib/installed.ts`); they are not a file in
any repository. A new device starts with Files, Todos and Honeycrisp,
installed through the same `install` as any app. Each entry records
`hostname`, `name`, `hash` and `installedAt`.

`hash` pins the bundle installed. A first-party bundle is compiled into the
shell, so its hash is the SHA-256 of its package's source as this build
compiled it (`vite.config.ts`). It is recorded and not enforced, since the
shell can only run the code it carries. What remains for a bundle served
from its own hostname:

- fetching its manifest and module from `https://<hostname>/`;
- hashing what was fetched, and serving the pinned files from then on (from
  Cache Storage, or the desktop's pinned builds, ADR-0680);
- an update as a new hash the person approves on `/me`;
- refusing an install whose collections clash with an installed app's (two
  apps naming one collection, or templates that could claim one file);
- Remove on `/me`, and moving the record to the account once accounts exist.

## One handle per open repository

The `[owner=name]/[repo=name]` layout opens the repository the address
names once, under `RepositoryGate` from `@epicenter/svelte`. It opens with
every installed app's collections together (`lensOf`, `src/lib/lens.ts`).
Moving between the repository's page and its apps keeps the handle, and
nothing opens again. Another address (a link, Back, Forward) closes it and
opens that repository instead. Installing an app changes the lens, so the
open repository opens again with it. Closing lists any typing that could
not be saved, with Copy text, on whatever page comes next.

A copy in this browser is a replica in this origin's private storage
(OPFS), owned by one tab's worker. Its manifest records whose repository it
is (`owner`, null for you), its id, its name here, and, when it syncs, the
account and the server. A copy kept only here has neither. The shell keeps
no list of its own: `src/lib/device.svelte.ts` lists the manifests.

## Join a synced repository

A repository that syncs shows its join link on its page:
`/<owner>/<repo>?server=<url>`. Opening it in a browser without a copy asks
whom to sync as, then makes this browser's copy bound to that server. Once
there is a copy, the address opens it and `server` leaves the URL. The Join
form on `/me` takes the same four values. Until accounts exist, whom to sync
as is any name the development server takes as the credential
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

## Settings

Settings follow ADR-0693 ("Settings are data"). No app has settings yet.

## Layout

| Path | Role |
| --- | --- |
| `src/lib/catalog.ts` | The bundles this shell can install, the defaults, and Files' hostname. |
| `src/lib/installed.ts`, `installed.svelte.ts` | The installed-apps record, and this browser's copy of it with the lens it implies. |
| `src/lib/lens.ts` | Every installed app's collections as one lens. |
| `src/lib/AppHost.svelte` | One app, mounted through its contract. |
| `src/lib/RepositoryBar.svelte` | The bar above every app: the repository, and where its files stand. |
| `src/lib/device.svelte.ts` | This browser's copies, addresses, `me`, home, create, join and remove. |
| `src/lib/open.svelte.ts`, `Opened.svelte` | The open repository's context, under the gate, and typing left unsaved when it closes. |
| `src/routes/[owner=name]/` | The owner page; under it, the layout that opens the repository, its page, and `[app=hostname]/[...path]/`. |
| `browser-tests/` | Playwright: the shell, Files, Todos and Honeycrisp, in Chromium and WebKit. |

## Checks

From `apps/web`:

| Command | What it checks |
| --- | --- |
| `bun run typecheck` | The shell and its browser tests. |
| `bun run test` | The bundle (no Yjs, Node or Bun module, no folder engine, every app's module included), the name rule, and the installed-apps record. |
| `bun run build` | The static site, into `build/`. |
| `bun run test:browser` | The built site with persistent profiles, one origin per person. It covers every page, hostname routing, apps sharing one open repository, reload and Back/Forward from the URL, Storage, a link to a missing app, joining by link, Files syncing between two profiles, and each app's own flows. |
