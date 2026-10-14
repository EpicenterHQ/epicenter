# 0476. Whispering's desktop folder uses one Rust library in both Tauri shells

- **Status:** Superseded
- **Date:** 2026-10-01
- **Superseded by:** [ADR-0531](0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md): Whispering's page runs the TypeScript folder engine over a directory its shell grants, and the Rust folder library is deleted.
- **Unbuilt:** Whispering folder and service integration in Epicenter and completion of the shared close protocol. Complete sidecar removal also needs Rust terminal, transcription, credential, reveal, and debug services, bundled frontend loading, and removal of sidecar packaging.

## Context

Whispering keeps its standalone desktop data in ordinary files through
`tauri-plugin-epicenter-folder`. The page attaches through
`@epicenter/folder/tauri`; Rust owns the folder. A Bun sidecar still serves the
page and supplies the terminal, provider requests, device settings, reveal,
debug fixtures, and close relay. Browser Whispering opens its OPFS directory directly.

Epicenter already grants trusted loopback-served pages focused Tauri commands.
Serving the SPA from Bun does not require Bun to open its data folder. A native
adapter shared by the standalone shell and Epicenter can remove Whispering's
second process and storage transport without duplicating its application model.

The shared adapter must preserve Todos' several pages sharing one folder owner.
Replacing HTTP with invoke cannot reduce that to one page per folder.
Applications migrate only after the native owner preserves their publication,
terminal, history, and shutdown guarantees. The older
[desktop packaging decision](0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md)
also excludes a standalone Whispering shell, contrary to the current README.
The proposed [three deployment forms](0493-whispering-runs-as-one-application-in-three-deployment-forms.md)
resolve that packaging discrepancy separately from the folder transport.

## Desired outcome

Whispering is one application with shared file semantics and two storage
implementations: OPFS in an ordinary browser and a shared Rust native
implementation in either desktop shell. How the page is delivered does not
change where desktop saves go.

| Where Whispering runs    | Page delivery                               | Saved data and native work                                                |
| ------------------------ | ------------------------------------------- | ------------------------------------------------------------------------- |
| Standalone desktop       | Bundled SPA loaded by Tauri                 | Ordinary files and Git through Rust; no Bun child or loopback server      |
| Inside Epicenter desktop | SPA served by Epicenter's existing Bun host | Ordinary files and Git through the same Rust implementation and typed SDK |
| Ordinary browser         | Static SPA from a web server                | OPFS folder and browser implementations; no native authority              |

The desktop app displays its canonical folder. A person can open its Markdown,
settings, and audio in another program without exporting. Existing folders
keep their file format and Git history when the native implementation changes.
Neither desktop shell keeps an IndexedDB mirror. Browser data remains separate;
switching environments does not silently copy, merge, or synchronize it.

A title edit or transcript save updates the ordinary files. Once publication
finishes, the UI reports the save independently of its background commit. A
blocked commit leaves the save intact and offers a retry. Long Git hashing does
not occupy filesystem admission for its entire duration. Detected external
file edits invalidate observations; a save that detects changed source reports
the conflict instead of replacing it. Canonical row editors overwrite a complete
document after the person resolves any observed foreign content. Dirty drafts remain visible for the
person to resolve. Detection remains best effort against external writers.

Transcribing a saved recording asks Rust to read the scoped audio and send it
to the configured endpoint. Its existing audio bytes and saved credential do
not take a round trip through the page. The page receives text and saves the
transcription using the shared table API. Endpoint and model remain ordinary
settings. The desired credential store is the operating-system keychain;
Settings can replace, clear, and show the presence of a saved key. Credential
identity across shells and verified migration of the current plaintext key
require their own decision before that service ships.

Several pages inside one desktop process attach to one folder owner and share
its history status. Closing one page leaves siblings and accepted native work
running. Standalone Whispering and Epicenter cannot own the same canonical
folder simultaneously; the second process reports that it is already open.
Switching shells releases that ownership and reopens the same saved files.

Hiding a retained page preserves drafts. Before destroying a dirty page, the
shell offers save, discard, or cancel and waits for the chosen action. Active
recording and transcription must finish or be explicitly cancelled before their
owning page is destroyed. Full quit stops admitting new native work, resolves
page-owned input, and drains admitted saves and history. A failed save offers
retry, discard the draft, or cancel quit. History failure remains separate and
can be left for the next launch; it never requires discarding an already saved
file. A crash or forced termination can lose unsaved input and unfinished
operations; it does not promise draft recovery.

## Delivery evidence

The replacement is complete only when both desktop entrypoints exercise the
same native implementation and the standalone release runs without Bun:

- Record, save, play, transcribe, edit, commit, reveal the folder, quit, and
  reopen against an existing folder without changing its format or history.
- Run the same native operations from Epicenter's served WebView; missing
  commands or authority fail visibly rather than opening browser storage.
- Demonstrate external edits, conflicting saves, partial publication, Git ref
  contention, and index-repair warnings without reporting a lost save as clean.
- Attach two pages, close the requesting page after a save, and finish its
  scheduled history while the other page remains usable. Refuse a second
  desktop process on that root.
- Exercise dirty-page destruction, in-flight recording/transcription, and
  shutdown failure, with no silent loss of page-owned input on a normal close.
- Build one SPA and run it in an ordinary browser, standalone Tauri, and
  Epicenter's served WebView. Browser execution loads no Tauri adapter and
  imports no Bun/Node native implementation. Withhold the native capability
  and prove acquisition fails without opening browser storage. Imports remain safe
  under SSR; default acquisition there refuses.
- Remove standalone sidecar scripts, binary packaging, bridge routes, and
  runtime dependence on a Bun executable.

## Decision

**Shared TypeScript interprets the files; a shared Rust library accesses native resources.**
The portable Folder implementation, `@epicenter/folder`, retains
table and KV interpretation, source-preserving patches, canonical row editors, and one-file publication
outcomes. The page retains drafts. Rust implements
scoped filesystem access, conditional publication, Git operations, watching,
and one history coordinator per native folder. Browser history retains its
TypeScript coordinator. Both Tauri shells register the same plugin and pages
import its generated TypeScript SDK, whether bundled or served by Bun. A page
cannot register Rust commands; the shell compiles and registers the plugin.
Saved files remain the sole durable application data; Rust creates no mirror
or convergent replica.

```text
App code: folder.tables / folder.kv / folder.files / folder.git
                              |
                 Shared TypeScript contract
                      +-------+--------+
                   Browser           Desktop
                      |                 |
              TypeScript logic    Generated TS bindings
              + isomorphic-git          | invoke
              + OPFS              Shared Rust plugin
                                  + files + native Git
                                  + history coordinator
```

Calling code uses the same `FolderGit` contract in either environment:

```ts
await folder.git.status();
await folder.git.commit();
```

The shared contract pins method meanings and result shapes, not one history
implementation. Browser history runs in TypeScript over isomorphic-git. Native
history runs beside disk in the Rust owner. The native TypeScript adapter maps
generated command results and transport failures into the existing outcomes,
and maintains the synchronous `git.snapshot` from native observations.
Another generic Git service above `folder.git` would duplicate that contract.

Native Git commands expose complete operations such as inspection, checkpoint,
and fast-forward. They do not expose `GitBackend.withObjects` callbacks or ask
the page to capture every file, build Git objects, or return incoming audio
bytes for publication. Checkpoint preparation and branch publication finish
inside the native owner; sharing a small formatter does not justify a
page-facing prepare/message/finalize protocol.

**A shell installs and registers the reusable folder plugin; its pages install the matching TypeScript SDK.**
The Rust crate contains the folder implementation, command registration,
permissions, and native lifecycle integration. Generated TypeScript bindings
supply callers and payload types; importing them cannot install native code.
The shell configures trusted roots and registers the plugin once. Capability
grants then authorize particular windows and, for served pages, origins.
Command registration and permission to invoke a command are separate steps.

Files, Git, watching, and native history scheduling stay together because they
share folder ownership. Transcription, credential use, and Whispering's terminal
capability compose with that owner without becoming mandatory dependencies for
every folder consumer. They can begin as Rust modules; separate crates require
an independent consumer or compilation boundary. A Whispering registration
helper can assemble its services without defining an all-purpose runtime that
every other Tauri app must install.

Both shells reuse the compiled implementation, not a cross-process service
instance. Each process has its own registry and owners; root locking excludes
competing processes. Excluding an optional component from compilation reduces
dependencies; withholding its window capability limits authority. These are
independent choices.

**The greenfield package is `@epicenter/folder`, paired with `tauri-plugin-epicenter-folder`.**
The Rust import is `tauri_plugin_epicenter_folder`; the Tauri plugin identifier
is `epicenter-folder`. These name one folder capability. The portable package
owns the shared contract and both adapters, including generated native bindings.
[ADR-0478](0478-folder-is-an-independent-package-with-automatic-and-explicit-openers.md)
records its automatic and explicit entrypoints and extraction from App. This
native migration does not rename App or move unrelated resources into Folder.

**Whispering's complete native service boundary runs in Rust without a Bun middle process.**
Both shells load the same native implementations and register their focused
Tauri commands. Browser implementations remain behind the platform seam.

| Current sidecar responsibility                    | Native owner                                                                                                                      |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Files, conditional publication, Git, and watching | The acquired Rust folder owner                                                                                                    |
| Transcription HTTP request                        | Rust reads scoped saved audio, obtains the credential internally, and sends the request; the page receives transcript text        |
| Credential access                                 | Rust owns device-local credential addressing and use; page operations set, clear, or inspect presence, never retrieve a saved key |
| Embedded terminal                                 | A Rust-owned shell session preserves directory, output limits, timeout, and cancellation behavior                                 |
| Reveal folder and native environment information  | Focused Rust commands resolve the app's native root                                                                               |
| Debug fixtures and failure injection              | Debug-only native capabilities, absent from release authority                                                                     |
| Close, drain, and cleanup                         | The shell and native owner share one lifetime protocol                                                                            |

The terminal remains an explicit user-facing shell capability. Typed Git
operations use direct executable arguments independently of that terminal.
Transcription performs no application-row mutation; TypeScript saves its
returned text through the shared table API. Network work does not hold the
folder mutation queue while awaiting the endpoint.

**Standalone Whispering loads bundled SPA assets through Tauri and starts no SPA server.**
Build and development tooling may use Bun. The installed application starts no
Bun child, opens no loopback API, and requires no Bun executable. Epicenter may
continue serving the SPA through its existing trusted Bun origin; that page
receives scoped native commands through Tauri capabilities. SPA delivery does
not supply Whispering's native services.

**The default `openFolder` selects its adapter at acquisition time.**
Application code imports it from `@epicenter/folder`. In a browser it lazily
loads the OPFS adapter; in Tauri it lazily loads the generated native
adapter and acquires the scoped API. Imports acquire nothing and load neither
storage implementation. Default acquisition under SSR refuses rather than
treating absence of Tauri as availability of browser storage.
Explicit entrypoints and optional build specialization follow the package
record. Target mismatch fails visibly rather than opening another storage.

The opener names the logical identity; a folder definition names none.
Browser storage uses it as its address; Rust resolves it through shell-configured scopes. An unknown native
identity fails, never creates an arbitrary root. It grants no authority and
does not make browser and native data the same store.

Once Tauri is detected, missing registration, denied capabilities, unknown
scope, and incompatible protocol fail visibly; none falls back to browser storage.
Acquisition verifies the SDK/plugin protocol before admitting mutations.
Generated types alone do not prove agreement with a separately built shell.
If all Tauri markers and IPC are absent, runtime code cannot distinguish the
page from a browser. Each shell must establish native bootstrap before app
startup so that missing injection cannot silently select browser storage.

One deployable artifact includes or references both JavaScript adapters. Lazy
imports defer loading; they do not remove native chunks from build output.
This deliberately replaces the earlier literal native-code exclusion with
browser-safe output and no native acquisition during browser execution. Bun
and Node filesystem implementations remain outside this portable graph.
Existing App services retain their own selection policy.

Portable author and automatic-history policy are declared once by the app.
Native acquisition checks normalized policy against the root owner and refuses
incompatible attachments with a precise mismatch; attachment order cannot
silently substitute another page's policy. Deployment-dependent Git remotes
belong to explicit environment configuration. A browser's `location.origin`
is not a portable default, and native acquisition must not silently ignore
requested configuration.

**One native owner serves every attached page for a canonical folder root.**
Native startup chooses roots, scope identities, and permitted windows. Pages
acquire a configured scope, never an arbitrary root. The plugin checks each
resource against the invoking window. A process-wide registry owns the folder,
history queue, and shared observation; page resources are clients. Detaching
one page leaves siblings and accepted history work running.

The owner has separate queues for filesystem admission and local Git work.
Checkpoint capture copies immutable bytes while excluding managed publication
batches, then releases filesystem admission before hashing. A short edit can
land while Git hashes a recording. Its revision makes the older observation
stale and requests the pending pass. Pull and terminal operations that need both
queues take filesystem admission before local Git, avoiding a lock cycle.

A separate process lock excludes another desktop process before initialization.
During migration it uses the existing sibling SQLite lock and exclusive
transaction; an unrelated
advisory lock would not exclude the current Bun owner. A mutex alone provides
neither process exclusion nor a shared history scheduler. External editors
remain supported.
Watch notifications invalidate observations; rereading files supplies content
and does not overwrite a dirty draft.

**Native publication preserves the existing save and history guarantees.**
Conditional file writes report completed steps when a later step fails. Checks
against external edits remain best effort, with a race between checking and
replacement. A completed save succeeds independently of its history attempt.
Read-only history observation writes no Git objects, index, or refs. Preparing
a candidate tree captures and hashes native bytes without sending audio through
IPC. The native owner derives the subject from its exact changed paths. Shared
golden fixtures pin the small message formatter in both implementations,
including escaping and the UTF-16 subject-length limit. Publication compares
and swaps the pinned parent; index repair failure is a warning after successful
publication. Newer edits invalidate an
older clean observation.

Complete publication requests a coalesced native checkpoint before answering
the save. Partial publication invalidates observations but requests no automatic
checkpoint. A later complete operation can include those landed bytes. The
native scheduler keeps one active pass and one pending pass and survives the
page that requested it. A prepare/message/finalize exchange with the page would
strand a saved file if that page disappeared before finalization.

**Closing a page and stopping native work follow one explicit lifetime protocol.**
The root owner retains admitted operations and watcher cleanup. Shutdown drains or
reports unfinished saves before releasing ownership. Rust persistence does not
save drafts held in page memory; the shell must guard destruction of a dirty
page. Moving storage alone does not provide that guard.

## Consequences

Whispering can delete its Bun storage host, high-level Folder RPC proxy, HTTP
authentication, value codec, event-stream recovery, and sidecar startup and
supervision protocol once all sidecar services have replacements. Sidecar build
scripts and binary packaging also disappear. Epicenter can continue using Bun
for SPA delivery and other services; this record does not claim that its
existing backend is already a static server.

The deletion prizes follow the responsibility moved, rather than the transport
renamed:

| Machinery removed from a migrated app                                                 | Replacement and deletion condition                                                                                        |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Whole-`Folder` RPC dispatcher, method allowlists, and table-entry wire validation     | Shared TypeScript tables and KV over scoped native publication commands; Rust validates authority and batch preconditions |
| Storage HTTP client, token plumbing, tagged value codec, ping, and reconnect loop     | Generated Tauri bindings and scoped native observations; required snapshot and invalidation handling remain               |
| Native Git object access through TypeScript and whole-folder byte capture in the page | Complete native checkpoint and fast-forward operations; audio stays native during history work                            |
| App-specific Bun folder owner and storage watcher                                     | One reusable Rust folder owner, watcher, and history scheduler; ownership is consolidated, not removed                    |
| Standalone sidecar startup, supervision, build script, and binary packaging           | Bundled Tauri frontend and Rust replacements for every remaining sidecar service                                          |

Do not first extract a shared HTTP folder client as a prerequisite for this
replacement. That would consolidate a transport the native adapter removes.
Keep the existing bridges usable until each app's native path passes acceptance,
then delete the replaced paths and transport-only tests in the same migration.
Tests for drafts, conflicts, partial saves, history, and shutdown remain.

The cost is a second implementation of publication and history behavior.
Shared `Folder` conformance scenarios must cover browser, existing Bun native,
and Rust implementations, including partial outcomes, fast-forward refusals,
automatic and manual history, cancellation, and page detachment. Formatter
fixtures alone cannot establish parity. Generated bindings check command types;
the conformance scenarios check their behavior.

This is a substantial runtime collapse, not a demonstrated net reduction in
repository code. Rust adds a native implementation while existing Bun adapters
remain for other callers. Path, portability, and refusal rules need shared
conformance evidence. The process lock prevents simultaneously owning the same
folder in standalone Whispering and Epicenter. Several pages inside one shell
share its native owner.

Todos' restricted TypeScript terminal needs a bounded native operation lease
to preserve whole-command ordering across its multiple invokes. The lease is
released on completion, timeout, or window destruction. Whispering's native
shell execution and page-approved close protocol remain application capabilities.

A throwaway Rust Git prototype passed 38 checks, published exact file bytes,
and avoided audio transfer for a 64 MiB fixture. It still rehashed those bytes.
It did not prove Tauri IPC, generated bindings, browser parity, conditional file
writes, acquisition, watchers, or shutdown. Those remain integration work.
Credential storage and migration to the operating-system keychain are a
separate decision from folder ownership.

## Considered alternatives

- Keeping a Bun folder owner reuses the existing native implementation and
  supports several page clients through one coordinator. It retains the
  standalone process and transport this decision removes.
- Moving the complete Folder model into Rust duplicates table, KV, and patching
  across browser and desktop implementations.
- Independent page history schedulers with a native mutex and Git ref CAS keep
  branch publication safe but cannot finish a vanished page's scheduled work.
  Sharing the native scheduler preserves completion and coalescing.
- Exposing Node-style filesystem calls over invoke moves Git's byte traffic
  into IPC and makes the page reconstruct native coordination.
- Build-selected adapters exclude the unused implementation but require
  separate artifacts and consumer selection configuration. They remain useful
  through explicit entries; they are not the default portable opener.
- Custom export conditions need coordination across bundlers and TypeScript
  resolution. Compile-time globals depend on dead-code elimination. A dedicated
  Vite plugin merely wraps one alias today; none earns a mandatory integration.
- Keeping Folder inside App avoids package extraction but makes an independent
  Folder consumer install unrelated App dependencies. A wrapper package above
  App retains that dependency closure while adding another API boundary.
- Keeping a standalone Bun process only to serve SPA assets retains startup
  and packaging that Tauri's bundled frontend already supplies.
- Replacing every Epicenter backend service at once couples Whispering's
  sidecar removal to unrelated application, authentication, and hosting work.
