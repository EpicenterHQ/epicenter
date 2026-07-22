# Tauri's Webview Doesn't Care What Serves It

> Historical article. Epicenter still uses a Tauri and Bun host seam, but the
> local Workspace CRUD, filesystem, and relay architecture described below was
> replaced by the desktop record owner and typed host protocol.

Tauri's `invoke()` IPC and a Bun HTTP server can run side by side from the same frontend. The webview loads from Bun, fetches data from Bun, and calls native Rust commands through `invoke()`: all on the same page, no hacks required. This is how Epicenter gets native OS APIs (audio, shortcuts, tray) from Rust while keeping all business logic in TypeScript.

## The Architecture

> **Note on current server topology:** The diagram below shows the local sidecar in isolation. In the full Epicenter architecture there is also a hub server (`createHubServer`) that runs separately and handles auth (Better Auth), AI streaming, and the cross-device Yjs relay. The local sidecar (`createLocalServer`) handles workspace CRUD, filesystem operations, extensions, and the local Yjs relay for the SPA on the same machine. AI requests from the SPA go to the hub, not to the local sidecar. This article focuses on the Tauri + Bun mechanics that apply to the local sidecar specifically.

```
┌───────────────────────────────────────────────────────────┐
│                    Tauri Process                           │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  Rust (thin shell)                                  │  │
│  │                                                     │  │
│  │  setup() {                                          │  │
│  │    spawn(bun-server sidecar)                        │  │
│  │    read port from stdout                            │  │
│  │    webview → http://localhost:N                      │  │
│  │  }                                                  │  │
│  │                                                     │  │
│  │  invoke_handler: [                                  │  │
│  │    start_recording,                                 │  │
│  │    stop_recording,                                  │  │
│  │    get_audio_devices,                               │  │
│  │  ]                                                  │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  Bun Sidecar (local server: HTTP server)           │  │
│  │                                                     │  │
│  │  GET /              → Svelte SPA                    │  │
│  │  GET /assets/*      → static files                  │  │
│  │  /api/documents     → workspace CRUD                │  │
│  │  /api/fs/*          → filesystem operations         │  │
│  │  /ws/sync           → Yjs sync (SPA ↔ local Y.Doc) │  │
│  │                                                     │  │
│  │  127.0.0.1:N                                        │  │
│  └──────────────────────────┬──────────────────────────┘  │
│                             │                             │
│  ┌──────────────────────────▼──────────────────────────┐  │
│  │  Webview                                            │  │
│  │  loaded from http://127.0.0.1:N                     │  │
│  │                                                     │  │
│  │  fetch('/api/documents')  ──► Bun (same origin)     │  │
│  │  invoke('start_recording') ──► Rust (ipc://)        │  │
│  └─────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────┘
```

Bun handles everything that's HTTP for local workspace operations: serving the frontend, API routes, WebSocket connections, Yjs CRDT sync between the SPA and the local Y.Doc. Rust handles what JavaScript can't: system audio devices, global keyboard shortcuts, native notifications, tray icons.

## Why This Works

Tauri injects `__TAURI_INTERNALS__` into every webview unconditionally. The code path in `manager/webview.rs` → `prepare_pending_webview` registers the `ipc://` protocol handler and the invoke key regardless of whether the webview loaded from `tauri://localhost` or `http://localhost:54321`.

When `invoke()` fires from a Bun-served page, this is the exact sequence:

```
invoke('start_recording', { device: 'default' })
    │
    ▼
__TAURI_INTERNALS__.invoke()
    │
    ▼
fetch('ipc://localhost/start_recording', {
    headers: {
        'Tauri-Invoke-Key': '<runtime key>',
        'Tauri-Callback': '<id>',
        'Tauri-Error': '<id>',
        'Origin': 'http://localhost:54321'   ← the Bun server origin
    }
})
    │
    ▼
Rust IPC handler:
  1. Validates Tauri-Invoke-Key  ✓  (injected at init, always matches)
  2. Extracts Origin             → http://localhost:54321
  3. ACL classifies as           → Origin::Remote
  4. resolve_access() checks     → remote.urls: ["http://localhost:*"]
  5. URLPattern match            ✓
  6. Executes Rust command       → start_recording()
```

The `ipc://` protocol handler sets `Access-Control-Allow-Origin: *`, so CORS never blocks it. The fetch goes to a custom protocol handler registered in-process; it never hits the network. If the custom protocol fails for any reason, `ipc-protocol.js` has a built-in fallback to `window.ipc.postMessage()`.

The one thing you need: a Tauri v2 capability that whitelists your localhost origin.

```json
{
	"identifier": "main-capability",
	"remote": {
		"urls": ["http://localhost:*"]
	},
	"permissions": ["core:default", "shell:allow-spawn", "shell:allow-execute"]
}
```

## The Rust Side

The entire Rust codebase shrinks to a sidecar launcher and a handful of native commands:

```rust
use tauri_plugin_shell::ShellExt;
use tauri::webview::{WebviewWindowBuilder, WebviewUrl};

#[tauri::command]
fn start_recording(device: String) -> Result<String, String> {
    // cpal audio recording: requires OS-level access
    Ok("recording_started".into())
}

#[tauri::command]
fn get_audio_devices() -> Result<Vec<String>, String> {
    // enumerate system audio input devices
    Ok(vec!["Default".into()])
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            start_recording,
            get_audio_devices,
        ])
        .setup(|app| {
            let (mut rx, _child) = app.shell()
                .sidecar("bun-server")
                .unwrap()
                .spawn()
                .expect("Failed to spawn Bun sidecar");

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    if let tauri_plugin_shell::process::CommandEvent::Stdout(line) = event {
                        let line = String::from_utf8_lossy(&line);
                        if let Some(port) = line.strip_prefix("PORT:") {
                            let url = format!("http://127.0.0.1:{}", port.trim());
                            WebviewWindowBuilder::new(
                                &handle, "main",
                                WebviewUrl::External(url.parse().unwrap()),
                            )
                            .title("Epicenter")
                            .build()
                            .unwrap();
                            break;
                        }
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running app");
}
```

Two commands and a sidecar launcher. That's the entire Rust backend.

## The Frontend

The frontend doesn't know which backend it's talking to. `fetch()` goes to Bun. `invoke()` goes to Rust. Feature detection handles web mode gracefully.

```typescript
import { invoke } from '@tauri-apps/api/core';

const isTauri = '__TAURI_INTERNALS__' in window;

// Bun backend: always available (desktop and web)
async function loadDocuments() {
	return fetch('/api/documents').then((r) => r.json());
}

// Yjs sync: always available
const ws = new WebSocket('/ws/sync');

// Rust backend: only inside Tauri desktop app
async function startRecording(device: string) {
	if (isTauri) {
		return invoke('start_recording', { device });
	}
	// Web fallback: browser MediaRecorder or "desktop only" message
	return navigator.mediaDevices.getUserMedia({ audio: true });
}
```

## Web Mode

Without Tauri, the Bun server runs standalone. Same frontend, same API, no Rust at all:

```
$ bun run server.ts
PORT:54321
Epicenter running at http://127.0.0.1:54321
```

`invoke()` calls don't exist because `__TAURI_INTERNALS__` isn't injected. The `isTauri` check catches this and uses browser APIs or shows "desktop only" for native features. Everything else: documents, Yjs sync, workspace operations: works identically.

## Why Bun Instead of Rust for the Server

Yjs is a JavaScript library. The entire CRDT layer in `packages/workspace/` is TypeScript. With a Bun server, the same Y.Doc code runs on both client and server: same sync protocol, same encoding, every Yjs plugin just works.

With a Rust server, you'd use `yrs` (the Rust port). It's wire-compatible but a different implementation. Every Yjs extension used on the frontend would need a Rust equivalent on the server. That's a serialization boundary where there doesn't need to be one.

| What it handles      | Bun (HTTP)           | Rust (IPC)                |
| -------------------- | -------------------- | ------------------------- |
| Frontend serving     | ✓ Static files + SPA |                           |
| REST API             | ✓ /api/\*            |                           |
| Yjs CRDT sync        | ✓ Native JS Yjs      |                           |
| WebSocket            | ✓ /ws/\*             |                           |
| Audio recording      |                      | ✓ cpal, OS-level access   |
| Global shortcuts     |                      | ✓ Native key hooks        |
| System tray          |                      | ✓ Platform tray APIs      |
| Native notifications |                      | ✓ OS notification center  |
| File watching        | ✓ Bun's fs.watch     | Alternative: notify crate |

The split is clean: if JavaScript can do it, Bun does it. If it needs native OS APIs, Rust does it.

## Sidecar Lifecycle

Tauri manages the Bun process automatically. The shell plugin kills child processes on app exit, even on crash. The `rx` channel in `setup()` lets you detect sidecar failure and either restart it or show an error dialog.

```
Tauri starts    → spawns Bun sidecar → reads port → opens webview
Tauri closes    → kills Bun sidecar automatically
Bun crashes     → rx channel receives exit event → restart or error dialog
```

The compiled Bun binary goes into `src-tauri/binaries/` with a target-triple suffix (`bun-server-aarch64-apple-darwin`, `bun-server-x86_64-unknown-linux-gnu`). Tauri's bundler picks the right one per platform. The user never sees it.

## The Tradeoff

You ship two binaries instead of one. The Tauri shell is ~5MB, the compiled Bun server adds ~30MB. Startup takes 100-200ms longer because the sidecar needs to boot and report its port. And sidecar crash recovery is complexity that doesn't exist in a single-process Rust server.

The payoff: your entire business logic is TypeScript. Your Yjs sync is native JS. Your dev loop is hot reload instead of recompile. And your web mode is just `bun run server.ts`: no Tauri, no Rust, same frontend.
