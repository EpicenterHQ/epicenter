# @epicenter/cli

> Shell access to Epicenter's supporting systems: machine auth, remote blobs, and typed markdown linting.

```txt
                 +--------+---------------------------------------------+
                 | Verb   | Job                                         |
                 +--------+---------------------------------------------+
   Auth          | auth   | manage the local machine auth session       |
   Blobs         | blobs  | upload and retrieve remote blob bytes       |
   Matter        | matter | lint a folder of typed markdown             |
                 +--------+---------------------------------------------+
```

The old Workspace watcher verbs (`up`, `down`, `status`, `logs`, `init`) and
their mount/daemon machinery retired with the Workspace model. A Data-native
filesystem projection would be a new product with its own owner, not a revival
of the watcher.

## Targeting an environment

When you iterate on `apps/api`, you want CLI commands hitting your local server,
not prod. The CLI reads `EPICENTER_API_URL` from the environment; named scripts
wrap the two real workflows so the target is always explicit.

| I want to...                                          | I run...                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| Develop against my local API server                   | `bun run cli:local auth login`                                         |
| Run from source against prod (rare: bug repro, demos) | `bun run cli auth login`                                               |
| Use the published binary (end user)                   | `epicenter auth login`                                                 |
| Override the target anywhere                          | `EPICENTER_API_URL=https://staging.example.com bun run cli auth login` |

Tokens are stored per API target so prod and local sessions coexist. Each target
writes one file at `<dataDir>/auth/<host>.json`, where `<dataDir>` is the
platform user-data directory from `env-paths('epicenter')` and `<host>` is the
API host with `:` replaced by `_`. A fresh `cli:local auth login` will not
overwrite your prod session.

`EPICENTER_DATA_DIR=<path>` overrides `<dataDir>` itself. Today the only
global user state stored there is cached credentials. This is the escape hatch
for Nix, snap, ephemeral homes, and the test suite.

The same env var and scripts apply to every command that talks to the API.

## Scripting

Generic off-process action invocation is deliberately not part of the CLI
surface. When a real write workflow needs shell access, add an explicit app
command for that workflow rather than a generic action bus.

## Public API

```ts
import { createCLI } from '@epicenter/cli';
```
