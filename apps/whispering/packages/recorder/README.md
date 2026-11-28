# @epicenter/recorder

The TypeScript commands and types for Whispering's native recorder plugin,
[`tauri-plugin-epicenter-recorder`](../tauri-plugin-epicenter-recorder/README.md).

The package has one file, `src/native/bindings.gen.ts`, exported as
`@epicenter/recorder/native`. The plugin generates it from its Rust commands
and types. Do not edit it by hand.

## Who imports it

[Whispering](../../README.md) is the only importer. Its desktop recorder in
`apps/whispering/src/lib/platform/recorder/` calls the generated `commands`
and reads the generated types. The browser recorder in the same folder uses
the page's own microphone and imports nothing from here.

```ts
import { commands } from '@epicenter/recorder/native';
```

## Regenerating

Run this in `apps/whispering/packages/tauri-plugin-epicenter-recorder` after
changing a command or a type in the plugin:

```sh
RECORDER_WRITE_BINDINGS=1 cargo test bindings
```

Without `RECORDER_WRITE_BINDINGS`, the same test fails when the file here is
stale.

## Checks

```sh
bun run typecheck
```
