# 0678. App databases open within runtime-bound scopes

- **Status:** Proposed
- **Date:** 2026-10-22
- **Amends:** [ADR-0314](0314-an-app-is-one-directory-and-installation-is-a-rename.md) at requiring `sqlite/<name>.sqlite` for app databases. The named database capability puts `<name>.sqlite` directly in the app-owned private root; this does not restore the retired source installer or define another asset lifecycle.
- **Relates:** [ADR-0701](0701-apps-run-as-separate-programs.md) makes each app its own desktop program, so no host holds an app's database; [ADR-0660](0660-native-apps-default-authored-work-to-the-epicenter-root.md) keeps authored Folders shared and app-managed state in each shell's AppData; [ADR-0673](0673-a-sqlite-handle-owns-one-connection-until-asynchronous-disposal.md) defines database admission, deletion, SQL operations, and connection lifetime; [ADR-0674](0674-standalone-apps-release-independently-from-one-monorepo.md) gives Epicenter and standalone apps independent releases.
- **Unbuilt:** `openDeviceDatabase` and `deleteDeviceDatabase`, native per-installation bindings, browser SQLite storage, and production connection cleanup. The existing `openFolder` already uses the browser origin or native window binding. SQLite adapters remain fictional-data prototypes.

## Context

Apps currently call `openFolder({ tables })`. The browser opens its existing
IndexedDB Folder; a native window opens the authored directory its shell bound
before the page loaded. Neither app call supplies an app identifier or path.
Several programs can open the same directory.

An application's private database has a different owner: the installed product
that updates its schema. One app has several installations: its desktop and
browser variants, and its release and development builds, each its own program
with its own AppData (ADR-0701). Sharing a database between installations would
make each release compatible with the other's private schema and migrations.
Sharing authored files already requires a portable file format, but does not
require sharing that private database.

## Decision

**An app opens a named private database in its current installation without
supplying a root or app identifier.** The app-facing operations are:

```ts
const db = await openDeviceDatabase('state');
await db.close();

// Explicit maintenance after all owners have closed the database:
await deleteDeviceDatabase('search');
```

These examples express the proposed contract, not implemented package exports.
Both functions return Promises. `openDeviceDatabase(name)`
returns the `SqliteDatabase` of ADR-0673. Opening creates the database if it
is absent; the app owns schema initialization and migrations.
`deleteDeviceDatabase(name)` removes that database under ADR-0673's
quiescence and failure rules. There is no parent device handle or generic
device-file API. A later need for assets or arbitrary private files can earn a
separate capability with its own lifetime and browser backing.

The name is one lowercase ASCII segment matching
`^[a-z0-9][a-z0-9.-]{0,63}$`. Periods and hyphens are naming punctuation;
neither creates a directory or a framework-parsed namespace. Callers supply a
logical name without the runtime's `.sqlite` extension. The native runtime
maps `state` to `state.sqlite` and `google.abc` to `google.abc.sqlite` in the
bound private root, including each database's SQLite journal and WAL companions.
The runtime always appends `.sqlite`; it does not parse a name as a filename or
strip an apparent extension.
The page cannot pass an absolute path, traverse directories, or select another
installation. A name identifies one database within one installation; the
runtime assigns it no account, Folder, remote, or person semantics. Applications
may keep multiple accounts in one database or choose stable names for
independently managed databases. The framework requires no account tree or
database catalog.

| Runtime | Private database root | Authored Folder |
| --- | --- | --- |
| Native app | That product's own AppData directory, for example `<OS AppData>/so.epicenter.todos/state.sqlite` | Its data folder (ADR-0701) |
| Browser app | This app's origin-local database storage; exact SQLite backend remains undecided | Its existing origin-local IndexedDB Folder |
| Native CLI or tool | A private root chosen explicitly by the tool's composition boundary | A directory chosen explicitly by the tool |

These are logical examples; the runtime resolves the platform-specific AppData
base. A development installation must have its own private root.

For example, the native database layout on macOS is:

```text
~/Library/Application Support/
  so.epicenter.todos/                  Todos
    state.sqlite
    search.sqlite
  so.epicenter.todos.dev/              Todos's development build
    state.sqlite
```

These files are outside the authored Folder. An app's AppData directory
already names its owner, so its databases sit directly there. No `sqlite/` or
`device/` level is required inside it. A product can create
other directories for an independently owned lifecycle, but the opener does not
require them. AppData may also hold non-database runtime state; this decision
does not promise that the directory contains only SQLite files. WebView caches
and credentials follow their own platform locations.

**The runtime binds identity before exposing the opener.** A native shell
uses its installed product identity and own AppData root. A browser origin is one app scope under this
decision; URL paths alone are not separate scopes. Missing native bindings
refuse opening. Changing the selected Folder or signing into an account does
not relocate a database.

The native shell resolves the root when it assembles the installation binding;
the page never invokes a path resolver. Database binding uses the product's
own AppData scope, never `DesktopPaths.data_dir`, which is Epicenter's own. The
runtime may create a missing admitted private directory; creation failure must
not select another root.

The browser implementation need not expose literal OPFS filenames. The
fictional-data [OPFS prototype](../../packages/folder/evidence/device-opfs/NOTES.md)
proves that one file-backed adapter can support SQL operations, but its
cross-origin-isolation requirement and contention behavior are not a production
selection. A pooled adapter may be considered because physical file transparency
is no longer promised. Browser origin retention, multi-tab contention,
interrupted work, and cleanup must be verified before shipping either backend.

## Mail database names and data ownership

**Use provider-qualified names for independently rebuildable account mirrors,
and keep authored records out of a catch-all private database.** A hypothetical
Mail app can use this flat native layout within its private root:

```text
state.sqlite                  optional private transactional state
google.<key>.sqlite            one Google account's mailbox mirror
microsoft.<key>.sqlite         one Microsoft account's mailbox mirror
```

The provider prefixes are `google` and `microsoft`. Within a Mail app these
identify the provider without adding another product-name vocabulary. Periods
separate readable parts of a flat name; they do not create folders. The app
derives each database name from its connection record rather than parsing the
filename to select a provider or schema. Each key is stable and distinct within
its provider, not the displayed email address. The complete name must fit the
owning capability's admission rules. This example prescribes neither an ID
allocation scheme nor a hash algorithm.

The data has distinct owners:

| Data | Owner |
| --- | --- |
| Non-secret connection definitions, account labels, drafts, and ordinary app preferences | The app's authored Folder; records intended to travel are eligible for its synchronization policy |
| This installation's connection activation and mirror references, plus private execution state with a justified local transaction invariant | The optional `state` database |
| Downloaded mailbox data and the sync position describing that copy | The corresponding `google.<key>` or `microsoft.<key>` database |
| Provider credentials | The appropriate secret store |

A synchronized connection definition does not activate or authorize another
installation. Private activation records refer to the definition and retain the
identity needed to name and clean up their mirrors; they are not a second
authority for user-authored labels or preferences. This decision prescribes no
particular Folder table or shared Epicenter connection catalog. Ordinary
settings do not require SQLite merely because they are device-specific.

`state` names private runtime state more clearly than `local`, because every
database here is local. It is not a required main database. An app with no
justified private transactional state need not create it. When SQL does own
pending work, the app names the invariant, retention, and recovery path;
rebuilding a mailbox must preserve that work.

A private transaction does not coordinate independent installations. Recovery
records that must prevent a second action on shared authored data belong with
those records or require an explicit cross-runtime protocol, as ADR-0660
requires. Moving send recovery into private `state` solely because it is
operational would not supply that coordination.

Google and Microsoft mirrors can use different schemas. In this Mail layout,
each database records its schema version internally, and the app owns upgrades
without renaming the database. Resetting one mirror resets its sync position
and preserves other mirrors, authored records, and retained private intent.

`PRAGMA user_version` is a candidate for that internal format marker. This
decision does not require it or grant that PRAGMA through the proposed SQL
handle; the fictional-data adapters currently reject app-issued access to it.
Choosing it would require a narrow read and write allowance. The app decides
whether a version mismatch warrants migration or a rebuild, and must establish
quiescence before deleting a mirror under ADR-0673.

This is an app layout decision, not a required database catalog or account
hierarchy for every app. Keeping connection definitions in the Folder does not
make the database file part of Folder synchronization.

## Consequences

The same `openDeviceDatabase('state')` call runs in every installation of an
app while resolving to different storage. Each installation migrates its own
private schema at its own release pace. Installations that read and edit the
same authored Folder need its file format to remain compatible across released
readers and writers. A private database cannot be the only place another installation must
look to understand those authored files.

Each app decides whether data in AppData can be rebuilt, needs backup, or
contains pending user intent. AppData is private placement, not a disposable
cache guarantee. The Mail example discovers connections from authored records
and this installation's activation state; the opener does not list databases or
interpret provider prefixes. Removing mirrors requires their exact names, so
the app must retain or recover the identity needed to name them until cleanup
succeeds, including when an authored connection definition disappears.

A database that must move between installations needs an
explicit export/import or other app-level transfer; a live SQLite file is not
shared through a symlink or raw copy. A database-aware snapshot would be a
separate capability. Credentials remain in an appropriate secret store.

No production SQLite opener, physical allocation, or browser backend is
implemented by this decision. A failed open never
silently chooses another database or storage engine.

## Considered alternatives

- **Share one private root between installations of one app.** Reduces
  duplicate local state, but couples independent releases to one schema and
  migration schedule. Shared authored files already supply the intended
  cross-installation work.
- **Use a neutral third AppData root.** Relocates the same database ownership
  problem without providing a service that owns the schema and versioned API.
- **Derive private storage from the selected Folder.** Gives one app different
  preferences and caches for each opened Folder and can make unrelated apps
  opening that Folder share private state.
- **Keep `openDeviceStorage()` with `files` and `sqlite`.** Adds raw-file and
  parent-handle contracts with no current app caller. It also constrains the
  browser backend solely to preserve file transparency.
- **Require `sqlite/` inside each app-owned root.** Adds a directory level
  without changing naming authority or lifetime. The database file already
  identifies its format; an app may add nesting when it has a real partition.
- **Allow hyphens but forbid periods in logical names.** Both are punctuation
  in one flat name. Periods make provider account names readable without
  introducing path or namespace operations.
- **Expose hierarchical database names or account storage scopes.** A validated
  relative database path need not expose a general filesystem, but one database
  per account does not require hierarchy. Grouping several databases and
  attachment files under an account, or removing that group together, can earn
  a separate scope and lifecycle decision.
- **Put SQLite inside the authored Folder.** Couples app-managed schemas to
  shared work and requires every tool or sync path to understand those files.
