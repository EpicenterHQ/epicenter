# Application architecture

`defineApp` declares and validates one schema. `openApp` acquires the resources
that schema needs for one page lifetime. Both belong to `@epicenter/app`, but
schema consumers can load the declaration without loading platform code.

## Consumers and opening boundaries

```text
Application data.ts / reusable tables / Worker probes
                     |
                     v
       @epicenter/app: defineApp, defineTable, field
                     |
                     v
              { id, title?, kv, tables }
                     |
          +----------+---------------------+-------------------+
          |                                |                   |
          v                                v                   v
 /open: openApp(definition, options?) /data: openData(...) /memory: openMemory(...)
          |                         caller-owned SQLite   Bun test storage
          |                                |                   |
          v                                +---------+---------+
 complete runtime (default or injected)              |
          |                                          v
          v                                one data document engine
 one App lifetime                          tables / KV / persistence / sync
          |
          +--> device store: account-local or no-account namespace
          +--> personal store: present with Account
          +--> shared store: present when Account supports Shared
          +--> SQLite / secrets / blobs / recording / AI connections
          |
          +--> app.ready: acquired stores and catalog are ready
          +--> app.close(): stop, drain, close, release ownership

App account stores <-- sync protocol --> @epicenter/app/sync authority
          |                                      |
          v                                      v
 IndexedDB current-library cache          server-owned opaque bytes

The same declaration --> /artifact and /artifact/checkout
Desktop folder I/O   --> /artifact/format (no App or store)
```

`openData(definition, sqlite)` owns the document, not the supplied connection.
Disposing it drains persistence and leaves SQLite open. `openMemory` owns a new
Bun memory connection unless its caller supplies a reusable `MemoryRecord`.
Neither opener constructs application capabilities or captures an Account.
Application tests supply `createMemoryRuntime()` from `@epicenter/app/testing`
to `openApp`. It passes its IndexedDB factory and key-range constructor directly
to shared native request handling, with no global mutation or constructor checks.
These tests use production readiness and closure with storage that survives
until runtime disposal. Real browser integration tests
use the default platform runtime.

Skills uses `openApp` in its account-taking lifecycle adapter. Its route still
refuses startup pending a product and authentication decision. The historical
numbered-cache helpers are removed; old bytes remain untouched. The server's
HTTP 409 refusal prevents current Personal initialization over admitted history.

## Source ownership

```text
packages/app/
|-- package.json                   public boundaries and build conditions
|-- src/
|   |-- index.ts                   platform-free declaration and schema vocabulary
|   |-- open.ts                    public openApp; selects a complete runtime
|   |-- runtime.ts                 AppRuntime resource contract
|   |-- testing.ts                 isolated memory storage and admission
|   |-- compose.ts                 private App readiness, retirement, and closure
|   |-- data/
|   |   |-- open.ts                public openData and syncEngineOf
|   |   |-- definition/            schema validation, branding, compilation
|   |   |-- field/                 field schemas and value validation
|   |   |-- store/
|   |   |   |-- index.ts           public store type facade
|   |   |   |-- store.ts           document construction and typed data surface
|   |   |   |-- handles.ts         row, table, and KV operations
|   |   |   |-- document.ts        Yjs document operations
|   |   |   |-- persistence.ts     durable queue and flushing
|   |   |   |-- persist.ts         browser persistent-storage request
|   |   |   |-- browser.ts         App-owned current-library acquisition
|   |   |   |-- current-cache.ts   IndexedDB current-library records
|   |   |   |-- idb-updates.ts     IndexedDB durable update log
|   |   |   `-- memory.ts          Bun SQLite test opener
|   |   |-- sync/                  transport, attachment, connection, authority
|   |   `-- artifact/              file grammar, import/export, working copies
|   |-- platform/                 build-selected browser and host resources
|   |-- recording/                browser and host recording lifetimes
|   |-- clipboard/                independent platform clipboard leaves
|   |-- browser.ts                internal browser AI binding
|   |-- ai.ts                     live AI capabilities and closure
|   |-- ai-connections.ts          custom connection persistence
|   |-- ai-connections.epicenter-host.ts
|   |-- native-ai.ts               host inference transport
|   |-- recorder.ts               recording capability contract
|   |-- blobs.ts                  standalone blob capability openers
|   `-- clipboard.ts              standalone clipboard selector
|-- evidence/data/                persistence, browser, and Worker probes
`-- scripts/                      browser and native capability evidence
```

`openApp` accepts `{ account?, runtime? }`. `AppRuntime` supplies admission,
document storage, SQLite, secrets, blobs, recording, and AI together.
`compose.ts` owns the one lifecycle used by all implementations. There is no
second App constructor for tests and no partial runtime fallback.

## Import and runtime boundaries

```text
Import                               Runtime requirement
@epicenter/app                       platform-free schema declarations
@epicenter/app/definition            platform-free schema tools
@epicenter/app/field                 platform-free field validation
@epicenter/app/store                 type-only data handle facade
@epicenter/app/data                  caller-supplied SQLite
@epicenter/app/memory                bun:sqlite data-engine test storage
@epicenter/app/testing               isolated IndexedDB and SQLite WASM App runtime
@epicenter/app/sync                  transport and authority; no App
@epicenter/app/artifact              document/file conversion; no App
@epicenter/app/artifact/format       file grammar; no store or App
@epicenter/app/artifact/checkout     working-copy operations; no App
@epicenter/app/open                  build-selected application capabilities
```

The package's `epicenter-host` and default conditions select the default
complete runtime through `#platform/resources`, including its AI binding.
Clipboard retains its independent platform seam. An explicit runtime replaces
the default without altering the inert declaration. ADR-0403's automatic
platform selector remains a proposal; consumers preserve build conditions.

One App admission covers its document stores and lazy SQL lifetime. A second
opener fails readiness immediately. Closure releases admission only after
resource cleanup succeeds, so failed readiness alone does not authorize a
replacement. The account-wide AI catalog spans multiple app IDs and retains
its own serialization. The host SQL owner still protects independent windows.
Memory SQL holds a runtime-owned `memdb` anchor and closes each App connection
physically; committed bytes survive, unfinished transactions and temporary
tables do not.

The package uses `@epicenter/device`, `@epicenter/blobs`, `@epicenter/recorder`,
and `@epicenter/client` for capabilities, and `@epicenter/sqlite`, `@y/y`, `idb`,
and `@epicenter/sync` for data and transport. These packages own mechanisms;
`@epicenter/app` owns their application lifetime.
