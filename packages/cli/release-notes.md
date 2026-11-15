Developer preview: install the Epicenter CLI, then copy a writing inbox into your own Epicenter.
The executable runs apps; each app is ordinary source you can edit.

Requires macOS or Linux on arm64 or x64, Git, curl, and shasum or sha256sum.
Bun and an AI account are not required. Configure Git's user.name and user.email
before initializing your Epicenter.

```sh
curl -fsSL https://github.com/EpicenterHQ/epicenter/releases/download/__RELEASE_TAG__/install.sh | sh
```

The installer prints commands using the executable's full path if `~/.local/bin`
is not on PATH. With that directory on PATH:

```sh
epicenter init ~/Epicenter
cd ~/Epicenter
epicenter new writing --from 'https://github.com/EpicenterHQ/epicenter#examples/writing'
epicenter serve
```

Open http://localhost:4747/writing/. Save a thought or quote with its source,
find it again, and edit it. Your notes live in `apps/writing/data/notes/`.
Connect an assistant through Streamable HTTP MCP at http://127.0.0.1:4747/.
The terminal must stay open while the server runs.

The installer verifies the executable's SHA-256 checksum. It changes no app
files, shell configuration, or login services. Source apps are downloaded
separately from GitHub; changes in the shared app do not overwrite your copy.
