# Service Organization And Platform Variants

Whispering runs as a browser page and in its own Tauri shell. This reference covers those two implementations.

## One build, the package picks

Whispering has one browser and desktop build (ADR-0781). It composes its capabilities in
`src/lib/app.ts`, and passes each service what it decides. A capability
package that owns a browser and a desktop implementation picks one when the
page runs: presence with `isTauri()` when its module loads, the desktop code
with `import()` when it first acts.

```ts
// @epicenter/recorder: src/index.ts
const shell = () => import('./tauri.js').then((module) => module.recorder);
export const recorder: Recorder = isTauri() ? shellRecorder : pageRecorder;
```

Each implementation exports the same declared shape, so a consumer sees one
contract wherever the page runs. A capability only one surface has is `null`
on the other (`localSpeech()` in a browser), and the view that uses it is a
branch on its presence (`{#if speech}`).

## A capability that keeps a key

`customEndpoints()` from `@epicenter/ai` keeps the endpoint list in
`connections.md` in this computer's settings (`@epicenter/local`) on every
surface. Where the key goes is `connection-keys.ts`'s choice: in a browser
it is kept in `connection-keys.json` beside the list; in a Tauri window it
is handed to the shell, which keeps it in the app's `credentials.json` under
the connection's id and applies it only while the connection still names
the endpoint it was saved for. The shell keeps the file private (mode `0600` on Unix). The page hands a key to the shell once and asks the shell to send the request that needs it. See [Whispering’s credential storage decision](../../../../docs/adr/0740-every-credential-an-app-holds-lives-in-its-own-place.md).

## Desktop services and the shared crates

Whispering's desktop shell uses `epicenter-standalone` plus
`epicenter-account`. A desktop implementation uses what they expose and
adds nothing that holds a credential in the page:

| Need | The desktop implementation uses |
| --- | --- |
| A secret (API key, connection) | `connectionKey` in `@epicenter/ai`'s `tauri.ts`, kept in the shell's `credentials.json` |
| A request with the person's account | `account.fetch` from `createTauriAuth`, relayed by `account_fetch` |
| A request to a custom endpoint or a server on this computer | `connection_fetch` (`shellFetch` with no key) |
| A native command over the data folder | the root's name (`'Data'`), which the shell resolves |

The browser's equivalents are this computer's settings (`localStorage`),
browser OAuth's `account.fetch`, and `fetch` (which needs the endpoint's
CORS rule).
