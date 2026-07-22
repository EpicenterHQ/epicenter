# @epicenter/cli

> Operate Epicenter authentication, remote blobs, and Matter from the shell.

The CLI owns three narrow tool families:

| Command | Job |
| --- | --- |
| `auth` | Log in, inspect the machine session, or log out |
| `blobs` | Upload, download, or remove one remote blob by address |
| `matter` | Validate typed Markdown whose source of truth is on disk |

The CLI does not open application replicas or keep a background process alive.
Applications and trusted hosts own their Epicenter lifetime and bind the Lenses
they use.

## Targeting an environment

`auth` and `blobs` read `EPICENTER_API_URL`. The repository scripts make the
two common targets explicit:

| I want to... | I run... |
| --- | --- |
| Develop against my local API server | `bun run cli:local auth login` |
| Run from source against the default hosted API | `bun run cli auth login` |
| Use the published binary | `epicenter auth login` |
| Override the target | `EPICENTER_API_URL=https://staging.example.com bun run cli auth login` |

Tokens are stored separately for each API target. Each target writes one file
at `<dataDir>/auth/<host>.json`, where `<dataDir>` is the platform user-data
directory from `env-paths('epicenter')` and `<host>` is the API host with `:`
replaced by `_`. A local login therefore does not overwrite the hosted session.

`EPICENTER_DATA_DIR=<path>` overrides `<dataDir>`. This is useful for Nix, snap,
ephemeral homes, and tests. `matter` is local and does not use either API
environment variable.

## Commands

```bash
epicenter auth login
epicenter auth status
epicenter auth logout

epicenter blobs add ./image.png
epicenter blobs get blob_...
epicenter blobs rm blob_...

epicenter matter check ./content-vault
```

`blobs add` accepts a local file or an HTTP URL. `blobs get` and `blobs rm`
accept either a `BlobId` or an Epicenter blob URL containing one. The blob store
has no list operation; application records own blob references.

`matter check` validates one marked table folder or a folder of tables. Matter
keeps disk as the source of truth and uses SQLite only as a read-only
projection. It does not access an Epicenter replica.

## Exit codes and output

Usage and local failures exit `1`. Remote blob failures exit `2`.
`matter check` exits `0` when all loaded rows are healthy, `1` for conformance or
reference failures, and `2` for unreadable input or a corrupt contract.

Errors go to stderr. Command results go to stdout. Blob commands support JSON
and JSONL output; `blobs add --format plain` prints only the created URL.

## Public API

```ts
import { createCLI } from '@epicenter/cli';
```
