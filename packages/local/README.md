# @epicenter/local

`settings` is this computer's settings for an app: one store of small text
files the page connects to once, beside its folder
([ADR-0778](../../docs/adr/0778-a-page-connects-once-and-then-reads-synchronously.md)).
A capability names each file it keeps with `settings.file(name)` when it is
made; the page connects to all of them at once, and from then every read
is synchronous. The package picks the place when it loads, with
`isTauri()`
([ADR-0781](../../docs/adr/0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md));
app code never opens or names it.

| Where the page runs | The place |
| --- | --- |
| a Tauri window | the top of the app's AppData root (`app_data_dir()`), written only by the shell, whose watcher tells every window; its code (`src/tauri.ts`) loads when the settings connect |
| a browser | this browser's `localStorage` for the site, under `epicenter.local/<name>` |
| tests (the `test` condition) | memory, empty at first; `outside` from `@epicenter/local/memory` plays another window |

```ts
import { settings } from '@epicenter/local';

const models = settings.file('models.md');
models.text(); // the file's text, or null; throws SettingsNotOpen before the settings connected
await models.write(text); // replaces the file (null removes it), once connected
await models.connected(); // for code that runs outside a page
const stop = models.subscribe(() => render());
```

`<WhenOpen>` takes the app's `settings` beside its folder and renders the
pages once both are open, so a page never reads a setting before it is
known. `settings.state()` is `opening`, `open`, or `failed` with
`SettingsError.Unavailable` and a `retry()`; settings that cannot be
reached fail the open, as the folder's would. A file that does not read is
the capability's to report, by a typed error naming the file; it never
holds up the connection, and saving a new value replaces it. A write
replaces the file without checking a version, because each place has one
writer.

## Who uses it

| File | Kept by |
| --- | --- |
| `models.md` | `@epicenter/ai` (`modelChoices()`) |
| `connections.md` | `@epicenter/ai` (`customEndpoints()`): each connection and the endpoint its key was entered for, never the key |
| `connection-keys.json` | `@epicenter/ai` in a browser only: each connection's key |
| `account.json` | `@epicenter/account` in a Tauri window: who is signed in, written by the shell |
| `microphone.json` | Whispering: the chosen microphone |
| `shortcuts.md` | Whispering in a Tauri window: this computer's shortcut override |

The desktop's `credentials.json` (the refresh token and provider keys,
[ADR-0740](../../docs/adr/0740-every-credential-an-app-holds-lives-in-its-own-place.md))
sits in the same AppData root but is not a setting: the shell refuses it to
every page. Transcription's Rust plugin keeps `local-transcription.json`
there on its own side.

## Why it is its own package

A capability such as `ai` keeps its own state here, and no capability imports another capability's code
([ADR-0755](../../docs/adr/0755-epicenters-packages-are-capabilities-formats-framework-layers-and-programs.md)).
So the place cannot live in `@epicenter/folder`, which is a capability.
This package holds no capability of its own: it is the layer every
capability's per-computer state is built on, as `@epicenter/definition`'s
formats are. It calls the shell's folder plugin commands by name and
imports no other Epicenter package.
