When you copy an app with a browser UI, `epicenter new` now prints how to
start the server and where to open the app. The address uses your Epicenter's
configured port. Try it with the public Tasks example below.

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
epicenter new tasks --from EpicenterHQ/epicenter/examples/tasks
epicenter serve
```

Open the address printed by `new` (by default http://127.0.0.1:4747/tasks/).
Add a task and reload the page. Its file lives in `apps/tasks/data/tasks/`.
Connect an assistant through Streamable HTTP MCP at http://127.0.0.1:4747/.
The terminal must stay open while the server runs.

The installer verifies the executable's SHA-256 checksum. It changes no app
files, shell configuration, or login services. Source apps are downloaded
separately from GitHub; changes in the shared app do not overwrite your copy.
