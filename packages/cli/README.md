# @epicenter/cli

The Epicenter CLI owns explicit cloud and portable-data workflows. It does not
run applications, discover mounted folders, or manage resident processes.

```text
epicenter auth       manage the saved cloud session
epicenter blobs      archive and retrieve content-addressed files
epicenter matter     check typed markdown
epicenter tables     review and apply portable SQLite edits
```

Application execution stays with the application that understands the data and
its upstream service:

```text
local-mail sync      refresh once, then exit
local-mail status    report durable mirror freshness
local-mail watch     refresh in the foreground until Ctrl-C

local-books sync     refresh once, then exit
local-books status   report durable mirror freshness
local-books watch    refresh in the foreground until Ctrl-C
```

Use `launchd`, cron, systemd, or another scheduler to invoke an application's
`sync` command periodically. A service manager may supervise `watch`. That
manager owns restart, shutdown, and log capture, so Epicenter does not add a
second PID registry or an `up` / `down` / `logs` command family around it.

## Targeting an environment

Commands that talk to the API read `EPICENTER_API_URL`. The repository scripts
make local and hosted targets explicit:

| Task | Command |
| --- | --- |
| Develop against the local API | `bun run cli:local auth login` |
| Run from source against the hosted API | `bun run cli auth login` |
| Use the published binary | `epicenter auth login` |
| Override the target | `EPICENTER_API_URL=https://example.test bun run cli auth login` |

Credentials are stored per API host. `EPICENTER_DATA_DIR` overrides the
platform data directory for ephemeral environments and tests.

## Public API

```ts
import { createCLI } from '@epicenter/cli';
```
