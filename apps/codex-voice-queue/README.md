# Codex Voice Queue

A personal review queue for local Codex conversations. Read a conversation, record a reply, and move to the next one after Codex accepts the message. A failed send keeps the text available to edit and retry. Transcripts show messages by default; other activity collapses into a closed "Activity" disclosure.

## How it works

```text
Browser -> Bun gateway on 127.0.0.1:5190 -> codex app-server (stdio JSONL)
                        |
                        +-> ffmpeg -> whisper-cli -> local Whisper model
```

The gateway owns the app-server process, pending approvals, and transcription queue. The browser polls its state every 2.5 seconds while visible. Conversation data stays in Codex; this app does not create a second transcript store.

## Run

From the repository root:

```sh
bun install --ignore-scripts
bun dev:codex-voice-queue
```

Open the URL printed by the gateway. Without `CODEX_VOICE_QUEUE_TOKEN`, the gateway generates a random token for each process and prints it in the URL fragment. If you supply `CODEX_VOICE_QUEUE_TOKEN`, the gateway prints the URL with a placeholder and never logs the token; append `#token=<your token>` yourself. Install `codex`, `ffmpeg`, and `whisper-cli` first and provide a local Whisper model. If recording or transcription is unavailable, the app shows a text composer with the reason.

For frontend HMR, run `bun run --cwd apps/codex-voice-queue serve` and `bun run --cwd apps/codex-voice-queue dev:ui` in separate terminals. Vite runs on port 5191 and proxies `/api` to the gateway on 5190.

## Host on your tailnet

For a persistent setup, run an installed copy of the gateway as a user service and publish it with Tailscale Serve. The browser loads the app and calls `/api` from one HTTPS origin, so no CORS configuration is needed.

```text
Tailnet device -> https://<machine>.<tailnet>.ts.net:<https-port> (Tailscale Serve, TLS)
               -> http://127.0.0.1:<gateway-port> (installed Bun gateway + static build)
```

Only devices in your tailnet that your Tailscale access rules allow can reach the Serve address. Serve is not Funnel, so the address is not reachable from the public internet. The gateway still requires the bearer token on every `/api/*` route. The Mac must be awake, signed in, and connected to Tailscale. If it sleeps, logs out, or the service stops, the app is unavailable.

Update an existing install from the repository root:

```sh
bun run --cwd apps/codex-voice-queue service:update
```

The command first runs the app typecheck and tests. If either fails, it stops without touching the install. It builds from the working tree; no commit is needed. It stages a bundle and UI in `releases/<id>`, then switches `current` only when `/api/state` shows no active turns or pending approvals. It checks before building and again before switching. If busy, unable to read state, or given an unrecognized turn or thread status, it exits without changing the running service.

On the first update of an existing root `server.js`/`build/` install, it copies those files into `releases/legacy`, keeps the root files, and migrates the wrapper with a backup at `run-gateway.sh.pre-releases`. The wrapper resolves `current` once at startup so the gateway and UI come from one release. Each update restarts the launchd job, checks authenticated health, waits for the app-server to be ready, and verifies the served UI and an immutable asset. A failed restart or verification triggers automatic rollback. Successful updates keep only the current and previous releases.

The command expects `run-gateway.sh`, `token`, and the launchd job to exist. It uses the fixed label `com.braden.codex-voice-queue` and install directory `~/Library/Application Support/CodexVoiceQueue`; override the directory with `CODEX_VOICE_QUEUE_HOME`. It reads the token file itself, never prints it or passes it in child arguments or environment, and never touches Tailscale Serve config.

A transcription or a reply being sent at the instant of the switch is not visible in `/api/state`. After a restart, the app reports such a reply as outcome unknown.

### First-time setup

Create a private install directory and stable token outside the repository:

```sh
app_data_dir="$HOME/Library/Application Support/CodexVoiceQueue"
mkdir -p "$app_data_dir" && chmod 700 "$app_data_dir"
(umask 077 && openssl rand -base64 48 | tr -d '\n' > "$app_data_dir/token")
```

For a fresh install, seed the first release once before starting the service:

```sh
bun run --cwd apps/codex-voice-queue build
mkdir -p "$app_data_dir/releases/bootstrap"
bun build apps/codex-voice-queue/server/main.ts --target=bun --outfile "$app_data_dir/releases/bootstrap/server.js"
cp -R apps/codex-voice-queue/build "$app_data_dir/releases/bootstrap/build"
ln -s releases/bootstrap "$app_data_dir/current"
```

Save this as `run-gateway.sh` in the install directory and set its mode to `0700`. Replace the executable paths and model path for your machine. Use absolute paths for Bun, Codex, ffmpeg, and whisper-cli because launchd starts with a minimal `PATH`.

```sh
#!/bin/zsh
set -euo pipefail

app_data_dir="$HOME/Library/Application Support/CodexVoiceQueue"
export PATH="/Users/<user>/.local/bin:/Users/<user>/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin"
export CODEX_VOICE_QUEUE_TOKEN="$(<"$app_data_dir/token")"
export CODEX_BIN="/Users/<user>/.local/bin/codex"
export WHISPER_CLI="/opt/homebrew/bin/whisper-cli"
export FFMPEG="/opt/homebrew/bin/ffmpeg"
export WHISPER_MODEL="$HOME/Library/Application Support/com.bradenwong.whispering/models/whisper/ggml-small.bin"
# Resolve current once so the gateway and its static files come from one release.
release_dir="$(cd "$app_data_dir/current" && pwd -P)"
export STATIC_DIR="$release_dir/build"
export PORT=5190

exec /Users/<user>/.bun/bin/bun "$release_dir/server.js"
```

Create and load a launchd user agent labeled `com.braden.codex-voice-queue`, with `ProgramArguments` pointing to this wrapper, `RunAtLoad` and `KeepAlive` enabled, and `StandardOutPath`/`StandardErrorPath` pointing to `stdout.log`/`stderr.log` inside the install directory. Start it before using `service:update`. The service must be reachable and idle for an update. Set `PORT` to a free loopback port; keep the exact `export PORT=<number>` form so the updater can read it. If you override the install directory, adjust `app_data_dir` in the wrapper too.

Do not put the token value in a plist, script, or file under version control. The wrapper reads it from the private token file when it starts. Because the token is supplied, gateway startup logs omit it.

### Rollback

```sh
bun run --cwd apps/codex-voice-queue service:rollback
```

Rollback swaps `current` and `previous`, restarts the service, and verifies health and UI. Add `--force` to skip the idle check when the service cannot answer. If verification fails, it leaves the selected release in place and reports the failure.

If the command cannot run, choose a retained release and run these inside the install directory:

```sh
ln -sfn releases/<id> current
launchctl kickstart -k gui/$(id -u)/com.braden.codex-voice-queue
```

To return to the pre-release install after migration, copy `run-gateway.sh.pre-releases` over `run-gateway.sh` and kickstart the job. The original root `server.js` and `build/` remain available for that wrapper. Check `stdout.log` and `stderr.log` if recovery fails.

### Tailscale Serve

Publish the gateway on an HTTPS port that has no Serve handler yet. Check existing routes first:

```sh
tailscale serve status
tailscale serve --bg --https=<https-port> http://127.0.0.1:<gateway-port>
```

Serve config is shared across the machine. Pointing an existing HTTPS port at the gateway replaces that port's route, and `tailscale serve reset` removes every route. To unpublish only this app, run `tailscale serve --https=<https-port> off`.

Open `https://<machine>.<tailnet>.ts.net:<https-port>/#token=<token>` once on each device. The browser stores the token locally and removes the fragment. The fragment is not sent to Tailscale or the gateway. Leave `CODEX_VOICE_QUEUE_ALLOWED_ORIGINS` empty for this setup. The same-origin check compares `Origin` with the forwarded `Host` header.

To rotate the token, replace the file, restart the service, and unlock each device again.

## Tunnel demo

A Cloudflare quick tunnel is for short demos only. Its URL is public, so the bearer token is the only barrier. Start the gateway, then:

```sh
cloudflared tunnel --url http://127.0.0.1:5190
```

Open `https://<random>.trycloudflare.com/#token=<token>` with the token printed by the gateway. The fragment never reaches Cloudflare or server request logs. The browser removes it after storing the token locally. Stop the tunnel when done.

For anything beyond a demo, use the tailnet setup above or put Cloudflare Access in front. Treat the URL and local browser storage as credentials. Anyone with the bearer token who can reach the gateway can read your local conversations and start agent turns.

## Security model

The token protects every `/api/*` route, including health and transcription. The gateway binds only to loopback and never exposes the raw app-server protocol. It pins resume to `workspace-write` and `on-request` by default, with `approvalsReviewer: 'user'`. Only `read-only` and `untrusted` are accepted alternatives.

Command and file-change approvals appear in the app. Approve once or decline them explicitly. The gateway refuses other server requests, records a notice, and directs you back to Codex when input is needed. An app-server exit fails active turns and clears pending approvals.

Tokens default to 32 random bytes per process. Only generated tokens are printed at startup. Authentication compares SHA-256 digests using a timing-safe comparison. After 20 failed authentications from one client in ten minutes, requests receive 429 until the window ends. The gateway trusts `cf-connecting-ip` when provided; direct callers can spoof it, so this limiter is not a substitute for Cloudflare Access. Behind Tailscale Serve, every request arrives from loopback. All tailnet devices therefore share one limiter bucket, and 20 failures from any device can lock out every device for up to ten minutes. There are no authentication cookies, so ambient cookies do not create a CSRF surface. The shared sidebar may store its display preference in a cookie; that cookie grants no access.

Static HTML uses a same-origin content security policy. API responses disable caching. Lock clears the saved token; use it on shared computers.

## Cloudflare Pages option

Deploy `apps/codex-voice-queue/build/` as a static SPA with fallback to `index.html`. Set `CODEX_VOICE_QUEUE_ALLOWED_ORIGINS=https://<pages-host>` on the gateway, restart it, and open:

```text
https://<pages-host>/#api=https://<tunnel-host>&token=<token>
```

The app stores the API origin and token in localStorage. Configure the static host's CSP to allow `connect-src` to that gateway origin. The gateway's own HTML CSP intentionally allows only same-origin connections. CORS allows exact origins from the configured list, with bearer authorization and JSON/audio content types.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `5190` | Gateway port; bind address is always `127.0.0.1` |
| `CODEX_VOICE_QUEUE_TOKEN` | Random per process, printed at startup | Access secret, at least 32 characters; never printed when supplied |
| `CODEX_BIN` | `codex` | Codex executable |
| `CODEX_VOICE_QUEUE_SANDBOX` | `workspace-write` | `workspace-write` or `read-only` |
| `CODEX_VOICE_QUEUE_APPROVAL` | `on-request` | `on-request` or `untrusted` |
| `WHISPER_CLI` | Located on PATH | whisper-cli executable path |
| `FFMPEG` | Located on PATH | ffmpeg executable path |
| `WHISPER_MODEL` | First existing default below | Local Whisper model |
| `WHISPER_LANGUAGE` | `en` | Whisper language code, or `auto` |
| `CODEX_VOICE_QUEUE_ALLOWED_ORIGINS` | Empty | Comma-separated exact browser origins |
| `STATIC_DIR` | `../build` relative to the server module | Static bundle directory; set explicitly for an installed bundle |

Default models are searched in `~/Library/Application Support/com.bradenwong.whispering/models/whisper/`, in order: `ggml-large-v3-turbo.bin`, `ggml-small.bin`, `ggml-tiny.bin`.

## Keyboard

| Key | Action |
| --- | --- |
| Space | Start recording, or stop and send |
| Escape | Cancel recording |
| j / ArrowDown | Next conversation |
| k / ArrowUp | Previous conversation |

Navigation shortcuts stay inactive inside inputs, textareas, buttons, selects, and editable content. Escape cancels an active recording even while a control has focus.

## Limits and checks

Archive & next removes a conversation from the queue through Codex's thread archive, which is reversible in Codex. The queue removes it only after Codex confirms, then selects the next visible conversation. Archive & next is disabled while Codex is working, an approval is pending, or a reply is in progress. Skip leaves the conversation unarchived.

Queue order stays fixed while reviewing. Reload keeps existing positions, prepends new conversations, and drops removed ones. The queue caps at 5000 conversations. Transcript pages contain ten turns; legacy `thread/read` fallback shows only the last ten. Only a small number of transcripts remain cached in the browser.

`thread/resume` pins policy for that thread in the current app-server session. Resumed threads are tracked until the process exits. The gateway prevents overlapping sends to one thread; work started in another Codex process may require handling there. Transcription is serialized with a 25 MB upload limit and a 120-second timeout per subprocess. WebSocket transport is not used.

```sh
bun run --cwd apps/codex-voice-queue typecheck
bun run --cwd apps/codex-voice-queue test
bun run --cwd apps/codex-voice-queue build
bun run --cwd apps/codex-voice-queue smoke
```

Smoke only initializes, lists conversations, and reads one page of turns. It prints counts and item tags, never preview or transcript text. It never resumes a conversation or starts a turn. `bun run --cwd apps/codex-voice-queue schema` refreshes the ignored local protocol reference; production imports use the hand-written type-only subset.
