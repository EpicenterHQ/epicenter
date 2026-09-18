# Application architecture

`@epicenter/app` owns an application's declaration and the lifetime opened from
it. The data engine is part of that package. Server authorities and reusable
features import independent modules without constructing an App.

## Consumers and imports

```text
Application authors                         Reusable features
Honeycrisp / Vocab / Whispering / Local Mail Chat tables / Skills tables
                  |                                      |
                  v                                      v
       @epicenter/app                       @epicenter/app/definition
       defineApp / defineTable / field       table vocabulary / compiler
                  |                                      |
                  v                                      |
       one inspectable declaration <---------------------+
       { id, title?, kv, tables, open }
          |             |             |
          |             |             +--> artifact rendering / checkout
          |             +----------------> /memory: Bun test store
          v
       .open(account?)
          |
          v
       open.ts: one App lifetime
          |
          +--> device store: account-local or no-account namespace
          +--> personal store: present with Account
          +--> shared store: present when Account supports Shared
          +--> SQLite / secrets / blobs / recording / AI connections
          |
          +--> app.ready: stores and catalog hydration completed
          +--> app.close(): stop, drain, close, release ownership

Server (hosted cloud or self-hosted)         Desktop host
                  |                              |
                  v                              v
       @epicenter/app/sync             @epicenter/app/artifact/format
       authority / framing            file paths / frontmatter / NDJSON
                  |                              |
                  v                              v
       server-owned opaque bytes      folder I/O, no store or App

App account stores <------ sync protocol ------> Server authority
       |
       +--> IndexedDB current-library cache, owned by the application
```

Skills also owns a full `defineApp` declaration. Its existing historical
browser opener consumes the schema without invoking `.open()`; this package
move does not migrate that application's startup behavior.

## Source ownership

```text
packages/app/
|-- package.json                  independent public entrypoints
|-- tsconfig.json                 browser-capable application checks
|-- tsconfig.epicenter-host.json   host build condition
|-- tsconfig.data.json            engine source check without DOM
|-- tsconfig.data.dom.json        browser persistence and evidence checks
|-- src/
|   |-- index.ts                  sole full declaration constructor
|   |-- open.ts                   readiness, retirement, closure, capabilities
|   |-- data/
|   |   |-- definition/
|   |   |   |-- define.ts         table branding and authoring constraints
|   |   |   |-- declaration.ts    schema contracts and field vocabulary
|   |   |   |-- compile.ts        validation and memoized compilation
|   |   |   |-- content.ts        plain-text codec
|   |   |   `-- addresses.ts, canonical.ts, json.ts
|   |   |-- field/               field schemas and value validation
|   |   |-- store/
|   |   |   |-- store.ts         document construction and typed store surface
|   |   |   |-- handles.ts       row, table, and KV operations
|   |   |   |-- document.ts      Yjs document operations
|   |   |   |-- persistence.ts   durable operations and scheduling contracts
|   |   |   |-- persist.ts       persistence controller
|   |   |   |-- browser.ts       browser opener and App backing
|   |   |   |-- current-cache.ts current-library IndexedDB records
|   |   |   |-- idb-updates.ts   IndexedDB update log
|   |   |   |-- memory.ts        Bun SQLite test opener
|   |   |   `-- errors.ts, log.ts, flush-on-hide.ts
|   |   |-- sync/                framing, attachment, connection, authority
|   |   |-- artifact/            import/export, file grammar, working copies
|   |   |-- direct.ts           explicit SQLite account-store entrypoint
|   |   `-- __benchmarks__/     store and checkout measurements
|   |-- platform/               browser and host resource composition
|   |-- recording/              browser and host recording lifetimes
|   |-- clipboard/              browser and host text clipboard leaves
|   |-- browser.ts              browser runtime and AI defaults
|   |-- epicenter-host.ts       host runtime export
|   |-- ai.ts                   live AI capabilities and closure
|   |-- ai-connections.ts       custom connection persistence
|   |-- ai-connections.epicenter-host.ts
|   |-- native-ai.ts            host inference transport
|   |-- recorder.ts             recording capability contract
|   |-- blobs.ts                blob capability vocabulary
|   `-- clipboard.ts            independent clipboard capability
|-- evidence/data/              CRDT, persistence, browser, and Worker probes
`-- scripts/                    browser and native capability smoke tests
```

## Runtime boundaries

```text
Import                                    Loads App/platform implementations?
@epicenter/app                            yes, statically loaded; declaration performs no I/O
@epicenter/app/definition                  no
@epicenter/app/field                       no
@epicenter/app/store                       no
@epicenter/app/sync                        no
@epicenter/app/direct                      no; caller supplies SQLite
@epicenter/app/artifact                    no
@epicenter/app/artifact/format             no; also independent of the store
@epicenter/app/artifact/checkout           no
@epicenter/app/memory                      no; imports bun:sqlite
@epicenter/app/store/browser               browser persistence
@epicenter/app/browser                     browser application runtime
@epicenter/app/epicenter-host               host application runtime
```

The synchronous `.open()` method keeps the root connected to statically loaded platform
modules. An inert declaration is not a platform-free dependency graph. Moving
opening to an independent public function would change that contract; this
arrangement preserves the existing method and lifetime instead. The [final
Claude review](../../docs/reports/20260918-app-data-claude-review.md) recommends
a separate opener and diagrams that proposed arrangement.

The package depends on `@epicenter/device`, `@epicenter/blobs`,
`@epicenter/recorder`, and `@epicenter/client` for capabilities. It depends on
`@epicenter/sqlite`, `@y/y`, and `idb` for store implementation, and
`@epicenter/sync` for the shared transport contracts. Those dependencies own
mechanisms used beyond this package; they are not alternate declaration APIs.
