# @epicenter/app

A store owns its tables, KV, and SQLite namespace. Local also owns a device-local
blob namespace. `openLocal` waits for document, blob, and SQL acquisition;
`openPersonal` waits for document and SQL acquisition. Closing either store fences
its acquired resources. Hosted blob access uses a captured Account independently
of a structured store.

`defineStore` declares a store's stable ID and schema. An application composes
the stores and services its workflows need; there is no aggregate App handle.
Importing the package root acquires nothing and loads no browser or native
implementation. A schema is required only for data stores.

```ts
import { defineStore, defineTable, field } from '@epicenter/app';
import { openLocal, openPersonal } from '@epicenter/app/open';

const definition = defineStore({
  id: 'so.epicenter.notes',
  kv: { language: field.string() },
  tables: { notes: defineTable({ fields: { title: field.string() } }) },
});
const local = await openLocal(definition);
// Acquire separately when an authenticated workflow needs synchronized data.
const personal = await openPersonal(definition, { account });
```

The definition ID names the document and SQLite namespaces, plus Local blobs. It uses the same
reverse-domain grammar as a host application ID, but an application may open
several definitions. Reusing a definition for Local and Personal preserves the
declared shape, not the dataset. Changing its ID selects a different persistent
address. Secrets take their own namespace IDs without a store definition.

For the naming decision, see [ADR-0430](../../docs/adr/0430-define-store-declares-data-and-products-compose-resources.md).

Local retains the same address across account changes. Personal captures the
account's authority, principal, and transport before asynchronous acquisition.
It never retargets. Closing either store leaves the other usable. Both expose
`tables`, `kv`, `sqlite`, `persistence`, `signal`, and `close()`; Local also exposes `blobs`. Their ID is `definition.id`.
Personal opens from its cached generation offline, or asks the authority to
select a generation when no cache exists. No Shared opener is exported.

## Rows and saved files

`RowOf<typeof tableDefinition>` infers a value snapshot: `id` plus the declared
fields. `CreateRowOf` infers the fields argument to `create`; `KvOf` infers KV
values. The live body is accessed separately through `table.body(id)`. These
types do not describe a complete saved file or include an attachment handle.

The current engine's `storedRow(table, id)` returns every stored field and the
live body without filtering through the definition. Its `StoredRow` result is
input to file rendering, not serialized Markdown or proof of durable storage.
`rowFile()` and `parseRowFile()` in the artifact format operate on Markdown text.

The proposed file-first model calls the saved unit a **data folder**, containing
tables of Markdown rows, root `kv.json`, and row-owned attachments. Say **row**
for the table member and **row file** when discussing its saved Markdown.
Source that an app cannot interpret must remain accessible as files; failure to
produce a typed row does not erase those bytes. See
[the file-authority direction](../../docs/adr/0450-current-files-own-portable-document-data.md).
The current stores documented here still use Yjs and own their acquired
resources. Naming the target does not change their persistence or lifetime.
[File folders](#file-folders) are a separate, explicit entry for data moved to
the file-first model; they do not change these stores.

## File folders

`@epicenter/app/files` opens a folder whose current files are the saved data.
There is no Yjs document behind it. The same `defineStore` declaration supplies
table fields. Declarations the file implementation cannot honor are refused at
open rather than ignored: a Yjs body codec (the body is Markdown text) and
reference fields (rename repairs no references). `openBrowserFolder` stores files, empty directories, and
private Git state in one IndexedDB database; `openNativeFolder` from
`@epicenter/app/files/native` opens an explicit directory and its `.git`. The
browser entry imports no Node or Bun module.

```ts
import { openBrowserFolder } from '@epicenter/app/files';

const folder = await openBrowserFolder({
  id: 'so.epicenter.todos',
  definition,
  git: {
    author: { name: 'Todos', email: 'todos@localhost' },
    remote: { url: `${location.origin}/git/todos.git`, branch: 'main' },
    // commitOnEdit: false for manual history; the default is true.
  },
});

const listed = await folder.tables.todos.list(); // { entries, unreadable }
const created = await folder.tables.todos.create({ fields: { title: 'Milk', done: false } });
const done = await folder.tables.todos.update(created.data!, { fields: { done: true } });
await folder.tables.todos.writeSource(done.data!, repairedMarkdown);
folder.git.subscribe((snapshot) => render(snapshot));
await folder.git.commitAndPush();
await folder.close();
```

| Member | Contract |
| --- | --- |
| `tables.<name>` | Rows at `<name>/<stem>.md`. An entry carries its path, exact `source`, `version` (SHA-256 and size of those bytes), fields, body, `issues`, and zero or one owned same-stem `attachment`. `get(stem)` returns `undefined` only for absence. `list()` keeps invalid readable rows as entries and reports undecodable files in `unreadable`. `create` is exclusive. `update`, `writeSource`, `rename`, and `delete` receive a captured entry and refuse if the file changed. |
| `kv` | Root `kv.json`, read and conditionally replaced like an entry. |
| `files` | Literal paths. `write(path, bytes, { expected })` takes a version, `'absent'`, or `'any'` (a deliberate overwrite) and copies the bytes before it returns to the caller. `open(path)` returns stable bytes. Raw writes never request commits. |
| `git` | A shared status snapshot, `status()`, `commit()`, `commitAndPush()`, `push()`, `fetch()`, `pullFastForward()`, and terminal-level `paths()`, `stage()`, `commitStaged(message)`, `diff()`, `log()`. |
| `signal`, `close()` | Closing fences new work and immediately cancels queued pushes and fetches and aborts the active transport. It then waits for admitted file operations, local commit passes, explicit Git operations (status, staging, a staged commit and its refresh, diff, log), and the cancelled transport to settle before releasing storage. |

`update` patches the captured source: it replaces only the touched frontmatter
value spans or appends new keys, and refuses rather than rewriting YAML it
cannot patch safely. Comments, quoting, key order, a byte-order mark, and CRLF
line endings survive. `writeSource` writes the supplied text exactly, so
invalid frontmatter can be saved and repaired. Frontmatter that parses but
cannot be converted (an unresolved or circular alias, or alias expansion past
the limit) is a frontmatter issue on a readable entry, and `update` refuses it.
`patchSource` and `readSource`
are exported for editors that keep their own buffer (ADR-0465).

A save returns once its files are published. With `commitOnEdit`, a table or
KV save then requests a background commit: one active pass and one pending
pass, no timer. Inside the Git lock, a pass pins the branch head, then captures
every source file, writes blobs and trees, writes a commit on that head with a
subject derived from the tree difference (ADR-0469), and moves the branch only
with a compare-and-swap. A pass that waited while a pull changed files and the
branch therefore captures the pulled files; it cannot commit an older capture
over them. A moved branch is reported and not retried.

Only a pass that a managed save requested pushes afterward, through an
independent runner that pushes the exact commit it pinned. `commit()` stays
local. `commitAndPush()` always commits and then pushes, awaiting the push its
pass started when requests coalesced. Commit and push failures never undo a
save.

Source files are tracked files plus untracked files that `.gitignore` does not
exclude; the root generated `index.sqlite3` and private Git state never are.
Status, commits, and incoming fast-forwards share this rule. The browser reads
`.gitignore` files from the folder; a native folder asks `git check-ignore`,
which also applies `.git/info/exclude` and the user's excludes file.

The shared index is not used to build a commit. Afterward, every index entry
that differs from the head is reset to it with real Git index commands,
including staged-only additions and deletions: a whole-folder checkpoint
supersedes staged-only intent. A pass with nothing new to commit still repairs
the index. If the index is locked after the branch moved, the outcome keeps the
commit and reports `indexWarning`; the next pass, such as an explicit commit
and push, retries. The saved-files observation is refreshed only when the
branch still names the committed head; otherwise it is marked stale and a scan
runs.

A caller `signal` on `commitAndPush`, `push`, or `fetch` only stops that
caller waiting (`stoppedWaiting`). Passes are shared, so the transport keeps
running; closing the folder is what aborts it.

Incoming changes are explicit: `fetch()` records the remote head, and
`pullFastForward()` applies it only when the whole folder, including staged
changes, is clean and the update is a fast-forward. Ignored and untracked files
are left alone; an incoming path that would overwrite one is refused as a
`Collision` before anything is written. The browser publishes the
files, index, and branch in one IndexedDB transaction. A native folder applies
ordered file steps, updates the index with `git reset`, and moves the branch
last; a failure reports the steps that completed.

A pull whose files landed but whose index or branch step failed
(`Partial`, `IndexFailed`, or `BranchMoved` with files applied) marks the
saved-files observation stale and requests a fresh scan; it requests no commit.

Native index and ref mutations use the `git` CLI, whose lock files other Git
processes respect; isomorphic-git writes only immutable objects there. Native
version checks are best effort against other programs. Multi-file native
operations report `Partial` results instead of rolling back, including a move
whose destination landed but whose source could not be removed. A partial
table rename or delete marks observations stale without requesting a commit.

A native whole-folder commit or fast-forward writes every file as plain
`100644` bytes without attribute filters, so it is refused, before any branch
or index change, in a repository it would misrepresent: tracked or untracked
(not ignored) symbolic links, executables, or other special files; submodules;
nested `.git` data; `core.autocrlf`; or `text`, `eol`, `crlf`, `filter`,
`ident`, or `working-tree-encoding` attributes on a source file. Reads, raw file
writes, and explicit native Git through `stage` and `commitStaged` still work.
Git LFS is not supported.

Table rows are files directly in the table directory. `get` refuses a stem
containing a path separator, and entry operations refuse a nested path such as
`todos/a/b.md`. A row whose external filename violates the stem rules stays
listable and editable. Rename and delete refuse when the current same-stem
attachments differ from the one the entry captured.

`@epicenter/app/files/terminal` runs a just-bash shell over a folder. The shell
reads and writes the same files, and its `git` command supports `status`,
`diff [--cached]`, `log`, `add`, `commit -m`, `push`, `fetch`, and
`pull --ff-only`. Its browser bundle references `node:zlib` for gzip commands
the terminal does not enable; the application aliases that module (see
`apps/todos/vite.config.ts`). The browser entry installs a `Buffer` global from
the `buffer` package for isomorphic-git; bundlers should alias `buffer` to the
same package for its dependencies.

Current limits: rename moves the row and attachment but repairs no references
(so reference fields are refused); `kv.update` rewrites `kv.json` whitespace;
browser bytes are stored as `Uint8Array` records, and every commit or status
check reads the whole folder.

## Resource constructors

| Subpath | Constructors | Required destination |
| --- | --- | --- |
| `/open` | `openLocal`, `openPersonal` | Definition; Personal also requires `account` |
| `/blobs` | `LocalBlobs` type | Borrow `local.blobs` |
| `/secrets` | `openSecrets` | `{ id }` |
| `/recorder` | `createRecorder` | `{ localBlobs }` |
| `/ai` | `openEpicenterInference`, `openRuntimeTranscriber`, `openEndpointInference` | Account, installed runtime, or endpoint URL |
| `/ai-connections` | `openLocalConnectionCatalog`, `openAccountConnectionCatalog` | No account, or `{ account }` |

Each owner exposes an abort signal and an idempotent asynchronous `close()`.
Close fences new operations immediately, then settles admitted work. Repeated
calls return the same completion, including a cleanup failure. Storage owners
retain exclusion when cleanup cannot prove competing writers would be safe.
Closing preserves committed data and credentials. It does not sign out, navigate,
or prove every edit reached durable storage or a server.

Default constructors select browser or host implementations with `isTauri()`.
`StoreRuntime` supplies document storage, local blob storage, SQLite acquisition, and admission to store openers.
`createMemoryStoreRuntime()` from `/testing` provides isolated IndexedDB-backed
store tests and a private WASM SQLite owner without changing globals. It retains committed data across handle
close and refuses disposal while a store still owns it. It supplies no simulated
recording, network, or credential capabilities.

## Blobs and recording

```ts
import { createRecorder } from '@epicenter/app/recorder';
import { createPersonalHostedBlobs } from '@epicenter/client';

const local = await openLocal(localDefinition);
const recorder = createRecorder({ localBlobs: local.blobs });
const hosted = createPersonalHostedBlobs(account);

const saved = await local.blobs.add(file);
const published = await hosted.publishPrivate(file);
// On success, published.data is the complete authority URL.
```

Local `add(Blob)` returns a BlobId in the definition's device-local namespace.
`local.blobs.copyFrom(otherLocal.blobs, id)` creates a separate Local object.
Local also supports `get`, `open`, `stat`, `list`, and `delete` by BlobId.
Closing the Local store fences its blob operations and recorder.

Hosted publication accepts supplied Blob bytes up to 25 MiB. The Account fixes
its Personal owner and authority; `publishPrivate` and `publishPublic` select
fixed read visibility and return a complete URL. `download(url)` fetches bytes
through the captured Account. `delete(url)` removes a known URL owned by that
Personal principal. The client checks URL shape, owner, and visibility in the
publication response; the server enforces permission. Public URLs can be used
directly for safe media. There is no hosted inventory or store-relative BlobId.

A row stores the URL as an ordinary string. Publishing bytes and saving the row
are separate writes. Retain a known URL when a row write fails so the row can
be retried without uploading again. A lost publication response may leave bytes
whose URL the client never learned. Closing a structured Personal store does not
cancel an independent hosted request; pass a workflow abort signal when its
publication should stop with that store. Account retirement fences network work.

Recorder Stop publishes locally and returns a Result containing
`{ blobId, durationMs, byteLength }`. The product separately creates its row.
Closing the Local store retires its recorders and waits for an admitted Stop
through the private writer after public admission is fenced. Closing the recorder
leaves Local usable. There is no remote recording destination.

## Results and presentation

Resource operations return typed Results for expected failures. Application
operations preserve those Results until a caller chooses recovery or presentation.
A UI boundary can use `toastOnError(result, title)` from `@epicenter/ui/sonner`;
it presents the error and returns the same Result. The resource package does not
import UI, show toasts, or choose retry behavior.

A workflow spanning bytes and rows must preserve completed work in its outcome.
If Stop saved audio but row creation failed, retain the blob ID. If hosted publication succeeded but storing its reference failed, retain the URL.
Retrying the row write must not publish again.

Cancellation and presentation belong to the workflow owner. Deliberate departure
need not show an error toast. Startup failures need a persistent failure state.
Openers and `close()` retain their rejecting Promise contracts; invalid or closed
handle use can throw. The product owns cleanup and the error boundary for these
failures. A Result presenter does not catch arbitrary exceptions.

## SQLite and secrets

Every store acquires a local SQLite namespace as part of opening. Named databases
open explicitly through `store.sqlite.open(name)` and return Results. Use
`store.sqlite.delete(name)` to delete one named database and retire its old
connections. The borrowed namespace has no `close()`; close the containing store.

Local uses the existing `no-account` address. Personal adds the captured authority
and principal using the existing hex path encoding. Personal SQL remains local:
it does not sync or project Yjs tables automatically. Closing drains admitted SQL
work and releases physical connections; failed cleanup retains exclusion.
Browser storage uses an owner-specific OPFS pool. Native storage uses the host
SQLite lifetime socket. Older pools and account-independent files remain untouched.
Local Mail starts in a fresh Personal SQL namespace.

`openSecrets({ id })` addresses credentials by application ID and label.
Browser credentials remain in document memory; native credentials use the OS
keychain. Closing a handle preserves values. Credentials never enter Personal
rows. Saved inference keys use their separate catalog namespace.

## Inference

```ts
import {
  openEpicenterInference,
  openRuntimeTranscriber,
  openEndpointInference,
} from '@epicenter/app/ai';

const hosted = await openEpicenterInference({ account });
const runtime = await openRuntimeTranscriber(); // null when absent
const endpoint = await openEndpointInference({
  baseURL: 'https://inference.example/v1',
  getAuthHeaders: async ({ signal }) => ({
    Authorization: `Bearer ${await credentials.getToken({ signal })}`,
  }),
});
await endpoint.client.models.list();
await endpoint.close();
```

Hosted and endpoint handles own OpenAI-compatible clients. The native runtime
exposes `listModels()` and `transcribe()` directly; it does not emulate HTTP or
provide chat. An available runtime's failure remains an error; no constructor
chooses a fallback. Protocol compatibility does not imply support for every
network SDK operation.

```ts
const runtime = await openRuntimeTranscriber();
if (runtime) {
  const models = await runtime.listModels();
  // Present models.data for selection when models.error is null.
  // modelId is the exact ID selected from that host-provided list.
  const transcript = await runtime.transcribe(
    { audio, model: modelId, language: 'en' },
    { signal },
  );
}
```

Model IDs are opaque host catalog strings, not a TypeScript literal union.
The host lists installed models and validates the requested ID at execution.
An unknown or removed model fails; no active-model fallback is selected.
Explicit requests do not change the host's active-model setting. Cancellation
suppresses delivery and close drains admitted native work without unloading
the shared engine.

Endpoint authentication has one option: `getAuthHeaders({ signal })`. Omit it
for an unauthenticated endpoint; return constant headers for a static key.
Callbacks are not persisted. The API supports HTTP authentication headers, not
request signing, mTLS, or provider-specific protocol transformations.

The client validates and fixes the destination before resolving credentials,
registers pending work before calling the callback, and combines handle and
request cancellation. Captured authentication overrides SDK request headers.
It suppresses SDK environment credentials, omits ambient cookies, refuses
redirects, and rechecks cancellation after authentication. Close waits for
credential resolution and response-body cancellation. Authentication failure
never dispatches an unauthenticated request. Native unsaved requests use a
protected host relay for SDK operations, including multipart transcription.

## Saved connections

Both catalogs persist locally and are shared across application IDs. The account
catalog partitions records by captured authority and principal; it does not sync
through Personal. The local catalog uses the `no-account` partition.

```ts
import { openAccountConnectionCatalog } from '@epicenter/app/ai-connections';
const connections = await openAccountConnectionCatalog({ account });
const id = await connections.add({
  name: 'My endpoint', baseUrl: 'https://inference.example/v1', apiKey: key,
});
const saved = connections.get(id)!;
await saved.client.models.list();
await connections.close();
```

Await mutations before showing success. Reads return saved fields and cached
clients without model discovery. Rename, reorder, and model-list changes retain
clients; destination or credential changes retire them. Omit `apiKey` when
updating to retain it; supply an empty string to remove it. Native explicit key
assignment changes the access version even when the value is unchanged.

Browser records may contain the explicit bearer key. Native snapshots expose
`hasApiKey` and an access version while the broker retains the key. Stale versions
cannot authorize requests. Do not sync or log client-bearing records.

Discover models through the selected client's `models.list()`. An unsaved preview
opens its own endpoint handle and closes it when finished or dismissed.
Applications own workflow selection; missing connections and changed accounts do
not select another destination.

## Data engine and adapters

`/definition`, `/field`, `/store`, `/sync`, and artifact entrypoints remain
platform-free. `/data` opens a document over caller-owned SQLite; disposal leaves
that connection open. `/memory` owns Bun test storage. See the
[data engine README](src/data/README.md) and [architecture map](ARCHITECTURE.md).

Svelte consumers call `fromData(store)` for each selected store. Root handles
normally live for the browser/WebView lifetime. Shared AppBoot captures the
account and gives product work a departure signal; it does not close returned
roots or retry acquisition in the same document. Document destruction ends the
roots, and the host retires document-owned native access. Products stop capture
when departure begins, even if navigation stalls. Explicit close remains useful
for earlier retirement and resource cleanup. Reload is not a save barrier.

Clipboard is stateless: import `clipboard` from `/clipboard` directly. It needs
no resource handle and has no artificial close operation.

Run `bun run --cwd packages/app test` and `typecheck` from the repository root.
`smoke:recording` exercises synthetic Chromium capture and playback;
`smoke:admission` exercises real browser document ownership. Synthetic capture
does not establish physical microphone behavior or restart recovery.

License: AGPL-3.0-or-later.
