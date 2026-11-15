# PROTOTYPE: Host-owned file runs

Can serve own a run that outlives its HTTP observer, with binary file inputs
persisted outside Git, replayed after reload, and never rerun after restart?
This fixture makes the receipt, every chunk, and the terminal outcome visible.
It performs no transcription service call and has no remote repositories.

## Run it

From the repository root:

```sh
bun packages/cli/prototype/runs-demo/serve.ts --port 4799 --fresh
bun packages/cli/prototype/runs-demo/acceptance.ts --port 4798
```

Open `http://127.0.0.1:4799/runs-demo/`. Select a text or audio file and start.
Reload midway, then use Pending to attach to the same id. Cancel requests a
cooperative stop on the host. Leaving the page only stops its observer.

Serve defaults to `/tmp/epicenter-runs-prototype`, with private runtime files in
`/tmp/epicenter-runs-prototype-runtime`. `--root <dir>` and `--runtime <dir>`
choose separate scratch directories. Both must be absent or carry
`PROTOTYPE-wipe-me.txt`; `--fresh` checks both markers before deleting either.
The personal `~/Epicenter` is refused. Acceptance uses
`/tmp/epicenter-runs-acceptance` and `/tmp/epicenter-runs-acceptance-runtime`.
Restarting without `--fresh` preserves records so recovery can be observed.

The app receives an `UploadedFile`. It yields
`{ kind: 'received', name, type, size, sha256 }`, then
`{ kind: 'text', index, chunk }` with a zero-based index. Text files produce
one chunk per word. Other accepted files produce `chunk 1 of n` through
`chunk n of n`, with `n = chunks ?? 4`. Each text yield waits `delayMs ?? 250`.
It returns `{ text, size, sha256 }`. Its action is read-only.

The page is bundled into the scratch app's `ui/dist/` at startup. There is no
`ui/index.html` or package build script in that app, so the normal UI refresher
leaves these prebuilt files intact. The generated page bundle begins with a
PROTOTYPE banner.

## Acceptance evidence

Every scenario prints its events or state and a PASS summary; the runner stops
at its first failure and always stops its subprocess.

| Scenario | What it proves |
| --- | --- |
| a | File bytes match the size and SHA-256 receipt; ordered words finish successfully; Pending is removed. |
| b | Identical admission joins; changed input or bytes conflict; only one execution starts. |
| c | Disconnecting the observer leaves execution alive; replay resumes without sequence gaps and includes all ten chunks. |
| d | Explicit cancel persists `cancel-requested`, stops further chunks, and ends with an error. |
| e | SIGKILL plus restart produces `interrupted`; duplicate admission cannot rerun it. |
| f | Attaching an unknown id yields an error without an admission request. |
| g | Size and MIME refusals, ordinary-call Blob refusal, direct HTTP refusal, and omission from MCP agree. |
| h | A failed browser journal write sends no request. |
| i | Existing Origin guards also protect run routes. |
| j | A substituted 503 admission ack observes one execution, finishes Ok, and keeps Pending until finished. |
| k | A blackholed admission ack times out after 20 s and observes one successful execution. |
| l | Unknown keeps the journal entry and can be checked again on the same Run without admission. |
| m | Returned finishes delete input bytes; cancelled threw finishes retain them. |

## Limits

- One host process owns the runtime. Cancellation is cooperative. File fields
  are top-level action inputs only; CLI and MCP refuse file-input actions.
- `start`, `attach`, and `pending` are reserved client words in this prototype.
- The host never reruns a recorded execution. A crash between the record write
  and the 202 leaves a run the client sees as interrupted, even if execution
  never started. Effects before interruption may already have happened.
- `events({ after })` at or past the terminal sequence receives no terminal
  event and eventually ends with `disconnected`. Use a fresh attach without
  `after` to recover the result.
- Files are limited to 15 MiB; admission JSON to 1 MiB; each yield to 256 KiB;
  each event log to 4 MiB. Upload admission checks a 512 MiB runtime budget;
  already accepted runs can grow their logs beyond that budget. Eight runs and 64
  observers may be active. Terminal records remain 24 hours; orphan uploads
  remain one hour. Input bytes are deleted only after a finish whose answer has
  `returned`. Finished errors (including cancel) and interrupted runs keep them
  until the 24-hour terminal TTL. Retained bytes count toward the 512 MiB quota,
  stay outside Git, and have no retrieval API.
- The host reserves 1 KiB of each log for terminal events. An oversized final
  answer becomes `finished` with a Usage error instead of the original answer.
- Fsync durability assumes the OS and disk honour fsync. The macOS Time Machine
  exclusion is best effort.
- `unknown` keeps the browser journal entry and is not memoized on the Run;
  another observation can check again. The journal stores metadata, never file
  bytes. There is no discard API or UI yet. The Codex prototype conservatively
  blocks further submissions for such an unresolved receipt. This prototype
  proves leaving after acceptance; interrupted input uploads do not resume.
- An ambiguous or timed-out admission ack observes the id instead of failing or
  resending admission. Only a definite 4xx admission refusal fails locally after
  the POST is sent. Admission ack and cancel requests each time out after 20 s.
- A sandbox that cannot bind a listener cannot establish socket or SIGKILL
  restart evidence. The exported acceptance scenarios can still check SDK and
  host behaviour through a temporary direct-fetch shim.

Verdict: the mechanism works for bounded uploads and host-owned execution.
Keep the API experimental while using the Codex voice flow to learn from it.

Verified on 2026-11-14 with a real Bun HTTP listener: all 13 acceptance
scenarios passed. Existing CLI regressions passed 49 tests. In the browser,
a 493,650-byte WAV uploaded, the tab closed, and a fresh tab attached to the
same run. Earlier events replayed, the remaining text chunks streamed, and
the final answer completed without a second execution.

The personal Codex app also used this API over its existing private Tailscale
URL. A 2,961,510-byte recording was accepted, and the tab closed during local
Whisper transcription. A fresh tab recovered run
`466fff92-4919-446f-9190-9c982cb8085f`. The host finished with `sent` and desktop
chat history confirmed exactly one new turn, ending with “voice reply accepted”.
Recovery stayed in the original chat. The app's 113 tests, typecheck and build
passed. This checks an uploaded audio fixture, not an iPhone microphone session.
Codex history still polls every five seconds; run phases stream independently.
