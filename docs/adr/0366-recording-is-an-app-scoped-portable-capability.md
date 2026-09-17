# 0366. Recording is an app-scoped portable capability

- **Status:** Proposed
- **Date:** 2026-09-08
- **Relates:** [ADR-0393](0393-rows-refer-to-blobs-without-owning-their-lifetime.md) (independent row references), [ADR-0401](0401-a-record-names-its-destination-at-creation.md) (original destination), [ADR-0380](0380-the-caller-owns-when-to-close-and-the-app-owns-resource-shutdown.md) (resource shutdown).
- **Unverified:** Physical microphone, whole-host interruption, installed WebView playback, Windows publication, and concurrent-device acceptance.

## Decision

The App recorder saves completed recordings into the canonical app-local blob
store. The App binds capture and local reads to the same app scope; the storage
adapter owns path and database naming. Start captures that scope and a live
recording identity before microphone acquisition. Successful Stop returns
`{ blobId, durationMs, byteLength }` only
after publication. That BlobId is immediately readable through
`app.blobs.local`. Duration is audio duration; byte length describes the saved
payload. No public FinishedFile, native-capture token, publish, or discard-file
handoff exists. The returned BlobId includes the actual file extension and is
the complete key consumed by `app.blobs.local.open(blobId)`.

A live capture identity is not proof that a saved object exists. Native capture
can select `.wav` before recording; browser capture must establish its actual
output format before selecting the saved key. Do not require the live control
ID and extension-bearing saved key to be the same string. Keep the selected
saved key through publication retries. Native audio remains outside the WebView
byte path, and publication need not make a second copy of a finalized file.

Creating a recording row is a later application operation. Its failure can
leave saved bytes without a row. Recording has no authority to create a row or
upload audio. Temporary VAD/dictation primitives remain separate and do not
acquire a durable history requirement merely because saved recording does.
The later workflow stores the returned BlobId as an ordinary row value; it does
not make the row own the bytes or create an automatic local-to-remote transfer.

Cancel releases unfinished capture. It cannot retract a committed blob. The
native implementation retains finalized bytes after retryable publication
failure and a bounded commit receipt for lost Stop responses. Retry returns the
same saved ID. The destination never changes after capture starts.

### Progressive writing has no recovery promise

Desktop capture appends mono PCM16 to a temporary WAV through a bounded queue
and buffered writer. Memory use is bounded by the capture machinery rather
than recording length. Finish the WAV with checked finalization at Stop.
Per-chunk durable prefixes, periodic header checkpoints, and in-capture fsync
are not required. Supported WAV size and storage errors remain explicit.

The entire unfinished recording may be lost before Stop confirms publication. No host-restart or page-reload audio recovery
is promised. Surviving temporary bytes are potentially salvageable, not a durable
product object. Startup does not sweep temporary files; cleanup requires proof
that their owner cannot still write. Saved files and
unconfirmed permanent publication are never temporary-cleanup targets.

A live device failure is reported to the workflow. The implementation may
finalize available output while that session is still alive, but no prefix
survival or automatic recovery guarantee follows. Capture and save errors must
not be disguised as complete audio or successful persistence.

### One native owner, independent sessions

The native host reserves each resolved input for one capture across windows.
Two Apps, or two sessions in one App, can use distinct inputs. Storage libraries
do not partition hardware ownership. No recovery-driven one-unresolved-capture
limit is part of this contract.

The host validates the invoking owner and opaque session identity. Commands,
events, and cleanup target that exact session. An old stop, key release, error,
or cancellation cannot affect a successor. Products retain their current
session handle for controls; they do not call an unqualified shared stop.

Resolve the system default once before reservation. An explicit missing input
fails without fallback. Backend device identity is separate from display name;
identical labels do not collapse inputs. IDs need not survive all hardware
reconfiguration. A competing start returns typed busy without interrupting the
owner. Preserve backend busy classification when supplied; do not guess it from
an unknown error. Permission, missing-device, and backend failures are Results.

Reservation covers acquisition, capture, and physical teardown. Register a
pending owner before asynchronous acquisition. Late success after owner loss
must dispose its own stream. The shared registry lock covers transitions only;
device opening, worker waits, disk I/O, inference, and teardown run outside it.
Release the input only once physical teardown is established. A failed release
must not block unrelated inputs. Bounded pending saves may continue after the
microphone is free under their original App owners.

This is admission within one host. OS clients and drivers can refuse capture.
Same-device fanout, synchronized tracks, and separate channels of one audio
interface require separate product decisions.

### Document loss releases resources

Reload does not necessarily destroy a native window. Removing audio recovery
therefore requires a proved way to revoke the old document's pending and active
capture. Host-observed document departure or fenced document replacement may
establish that boundary; best-effort JS unload alone cannot. A live lookup may
help identify abandoned sessions for cleanup, but it must not resurrect durable
capture recovery or let a refused opener cancel another owner's session.

Window destruction tears down all its sessions. App close settles only the
sessions it owns; other Apps continue. Browser capture belongs to its document
and has no shared native admission guarantee. The tray reflects active capture.

Before deliberate departure, applications finish/save wanted output or cancel.
Close drains admitted recorder publication before releasing its private writer.
That writer remains usable even after public App blob access is revoked.
Unfinished capture may be discarded; committed files survive closure and
retirement. Cleanup owns staging only, including after an ambiguous commit.

The byte adapter owns native paths, durable publication, conventional media
types derived from extensions, and cleanup.
Capture owns only its temporary writer and device. No native storage module
names Whispering. Audio decoding uses ordinary local reads. Apps compose capture
and inference themselves; no shared dictation workflow is introduced.

## Consequences

Capture no longer depends on row existence, attachment completion cells,
generation-aware staged recovery, or acknowledgment after save. It still owns
resource lifetime and exact session control. Stop proves local publication and preserves unknown outcomes for retry.
Explicit hosting remains separate from capture and inference.

## Considered alternatives

- Create the recording row before acquisition: required only by the withdrawn
  draft/recovery promise and leaves placeholders after permission failure.
- Treat progressive disk writes as recovery: surviving bytes do not establish
  discoverability, ownership, valid finalization, or bounded loss.
- Remove all session state with the journal: loses device ownership and lets
  late commands affect successor captures.
- Keep one global host slot: prevents independent microphones from being used.
- Save every temporary dictation: imposes history and cleanup on text consumers.
- Send native audio through the WebView for saving: adds an avoidable whole-file transfer.

## Implementation and proof

Current implementation lives in packages/app/src/recorder.ts, its browser and
desktop adapters, and apps/epicenter/src-tauri/src/recorder. Commit 09b1965e55
implements the superseded row-first local checkpoint. Its passing tests and
SIGKILL staging recovery exercise that earlier promise.

Automated tests cover lost responses, stale callbacks, pending-start cleanup,
Stop publication, and independent Rust/Bun publication of flat extension-bearing
files. WebKit and Chromium checks exercise App recording with synthetic audio,
saved-key playback, and document reload. These checks do not establish physical
microphone, whole-host interruption, installed WebView playback, or Windows
durability. Native per-device admission also needs real concurrent-device
acceptance; source compatibility is not proof.

The [capture plan](../../specs/20260912T122859-concurrent-native-capture.md) owns
native admission only. Its finished-file handoff and separate library-save
instructions are superseded by this decision. The
[blob package](../../packages/blobs/README.md) describes the implemented layout.
Successful Stop already means saved; admission work must preserve that boundary.
The [remaining cleanup plan](../../specs/20260909T010040-current-generation-restore.md)
preserves these recording guarantees while separating unused backup machinery
from live library safeguards. The older attachment direction is withdrawn.
