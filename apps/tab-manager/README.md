# Tab Manager

Tab Manager keeps two kinds of data separate:

- Live tabs belong to the browser. The extension observes and acts on them but
  does not replicate them.
- Web captures belong to Epicenter. They form one local-first SQLite inbox that
  can synchronize across signed-in browsers.

The durable product has three verbs: capture, open, and discard. Opening a
capture creates a browser tab and removes the inbox row only after the browser
accepts the URL. There is no device model, permanent bookmark twin, tool-trust
store, or chat history.

## Architecture

```text
WXT side panel
|-- browser.windows and browser.tabs
|   `-- ephemeral live-tab observation and actions
`-- epicenter-tab-manager-v1
    `-- SQLite webCaptures table
        `-- local OPFS or authenticated record replication
```

The extension chooses one workspace connection at boot. Signed-out use opens a
local standalone inbox. Signed-in use opens the principal's replica. The shared
workspace runtime owns the SQLite Worker, storage identity, authenticated HTTP
replication, and reconnect behavior.

The version 1 schema is committed in `workspace-version-lock.json`:

```ts
type WebCapture = {
	id: WebCaptureId;
	url: string;
	title: string;
	favIconUrl: string | null;
	capturedAt: InstantString;
};
```

## Development

From the repository root:

```bash
bun dev:tab-manager
```

For the extension UI alone:

```bash
bun dev:tab-manager:ui
```

Load `apps/tab-manager/.output/chrome-mv3-dev` from `chrome://extensions` with
Developer Mode enabled.

Package checks:

```bash
bun run --cwd apps/tab-manager check:workspace-version-lock
bun run --cwd apps/tab-manager test
bun run --cwd apps/tab-manager typecheck
bun run --cwd apps/tab-manager build
```

Tab Manager is part of the Epicenter monorepo and is AGPL-3.0 licensed.
