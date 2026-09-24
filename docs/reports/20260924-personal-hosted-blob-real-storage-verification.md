# Personal hosted blob real-storage verification

Date: 2026-09-24 (Singapore)

Result: **passed** for the Personal lifecycle and Chrome audio playback. A later
conditional-range probe exposed one HTTP correctness bug, repaired in the
authority route after this first pass.

## Environment

- Committed Personal authority API from `670f85ba5d`, with deployment guidance from `59a26522d0`.
- `apps/api/server.dev.ts` on Bun with its local synthetic `Bearer dev:<principalId>` resolver.
- A disposable `ghcr.io/versity/versitygw:latest` container using the POSIX backend, a temporary host directory, a throwaway `epicenter-blobs` bucket, and `BLOBS_S3_*` pointing only at `127.0.0.1`. The server used its production S3 client and SigV4 path. No production storage or deployed API was contacted.
- Google Chrome 142 in a temporary headless profile for the public audio check.

## Evidence

- `bun run smoke:local` against the configured gateway: **5 pass, 0 fail, 0 skip**. It resolved a dev session, published a private object (201), read matching bytes (200), and deleted it (204).
- A second HTTP and Account-bound client run published private and public objects through `createPersonalHostedBlobs`. The client downloaded exact private bytes. An anonymous private GET returned 401; a different principal returned 403. Private HEAD returned the correct length with no body. A private `bytes=8-12` GET returned 206, the expected `Content-Range`, and exact bytes.
- The public object contained a valid one-second, 8 kHz PCM WAV. Anonymous GET returned exact bytes and `audio/wav`, `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`, and `Content-Security-Policy: sandbox; default-src 'none'`. Anonymous HEAD returned the correct length with no body. Anonymous `bytes=44-63` GET returned 206, the expected `Content-Range`, and exact bytes.
- A different principal could not delete the public object (403). An unauthenticated public DELETE was also denied (403). The owner deleted both objects (204); subsequent reads returned 404. Listing the disposable S3 bucket after the run showed no objects.
- Headless Chrome loaded the public WAV in an HTML `<audio>` element. Its network response was 206 with `audio/wav`, `inline`, `nosniff`, sandbox CSP, `Accept-Ranges: bytes`, and `Content-Range: bytes 0-16043/16044`. `loadedmetadata` fired with a one-second duration and `readyState` 4. `audio.play()` resolved, playback was unpaused, and `currentTime` advanced beyond 0.22 seconds without a media error.

## Conditional range follow-up

The first pass did not exercise a mismatched `If-Range` validator. A later
request for `bytes=0-2` with a false ETag returned 206 and `abc` from a ten-byte
object. [HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.5)
require the full representation when `If-Range` does not match.
The route now checks the current storage validator before requesting the range.
Against the same disposable gateway, a matching ETag returned 206 and `abc`;
a mismatched or weak ETag returned 200 and `abcdefghij`. The object was deleted
afterward. The focused blob suites passed 24 tests and 80 assertions, and the
server package typecheck passed.

## Limits

- This verifies the Bun runtime with dev auth and a real local S3-compatible gateway. It does not verify Cloudflare workerd or R2 transport, production authentication, or a deployed environment.
- Chrome decoded and advanced the WAV in headless mode. Audible output and a visible browser control were not checked.
- Shared-owner routes, owner-wide erasure, and Capture integration were outside this run.
