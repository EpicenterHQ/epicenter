# @epicenter/local

`localFile(name)` is one text file a capability keeps on this computer, in
the app's one place for such state. The build picks the place
([ADR-0766](../../docs/adr/0766-an-apps-capabilities-are-module-values-opened-synchronously.md));
app code never opens or names it.

| Build | Condition | The place |
| --- | --- | --- |
| desktop | `tauri` | the top of the app's AppData root (`app_data_dir()`), through the shell's folder plugin by root name |
| web | `default` | this browser's `localStorage` for the site, under `epicenter.local/<name>` |
| tests | `test` | memory, empty at first, for the process |

```ts
import { localFile } from '@epicenter/local';

const models = localFile('models.md');
const read = await models.read(); // Ok({ text, version }) or Ok(null)
const written = await models.write(text, read.data?.version ?? 'absent'); // Ok({ version }) or Ok('stale')
const stop = models.subscribe(() => reread());
```

A write lands only over the version its writer read (`'absent'` for a file
that is not there), so two windows never overwrite each other unseen. A
subscriber hears this window's writes, the desktop shell's watcher, and
another tab's `storage` event. When the place cannot be reached, `read` and
`write` answer `LocalFileError.Unavailable`.

## Who uses it

| Capability | File |
| --- | --- |
| `@epicenter/ai` | `models.md` (`modelChoices()`); on the desktop also `connections.md` (`customEndpoints()`), whose keys are in the keychain |

Transcription's Rust plugin keeps `local-transcription.json` in the same
AppData root on its own side.

## Why it is its own package

A capability such as `ai` keeps its own state here, and no capability imports another capability's code
([ADR-0755](../../docs/adr/0755-epicenters-packages-are-capabilities-formats-framework-layers-and-programs.md)).
So the place cannot live in `@epicenter/folder`, which is a capability.
This package holds no capability of its own: it is the layer every
capability's per-computer state is built on, as `@epicenter/definition`'s
formats are. It calls the shell's folder plugin commands by name and
imports no other Epicenter package.
