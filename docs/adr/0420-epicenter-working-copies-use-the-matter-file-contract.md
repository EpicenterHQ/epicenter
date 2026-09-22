# 0420. Working copies use an executable config and shared Markdown parsing

- **Status:** Accepted
- **Date:** 2026-09-22
- **Amends:** [ADR-0125](0125-record-definitions-are-release-local-lenses-and-never-migrate-user-data.md) at runtime write validation: ordinary store assignments, including permitted working-copy edits, preserve JSON values independently of conformance. Definitions remain consumer-specific read lenses and never migrate stored data; static authoring types are not a runtime write gate.
- **Implemented boundary:** Executable-config validation, shared YAML parsing for Matter and Epicenter artifacts, strict malformed-input refusal, and artifact JSON-value validation.
- **Unbuilt:** Owner-routed field-only Pull/Push and checkout-aware Matter integration.

## Context

People and agents edit Markdown frontmatter and root `kv.json`, then explicitly
Push the intended field changes. A definition describes how a consumer reads
those values; it does not own every interpretation of the stored data.

An editable JSON schema introduced another input language, object-admission
checks, and schema conversion work. Generating JSON from TypeScript would keep
both paths and introduce a question about which file is current. The user
explicitly accepts installing config dependencies and ordinary execution
failures. Dependency-free validation is not a requirement.

## Decision

**One root `epicenter.config.ts` supplies the working folder's read lens.**

The config default-exports a definition accepted by the existing `compileData`
path. It can construct that definition with `defineApp`, `defineTable`, and
`field`, or import an existing developer definition. No second config builder,
JSON loader, or generated schema is required.

```text
working-copy/
  epicenter.config.ts
  kv.json
  recordings/
    <recording-id>.md
  .gitignore
  AGENTS.md
  .epicenter/
    manifest.json
    query.sqlite          # optional, disposable
```

The root config replaces the proposed `store.schema.json`, `kv.schema.json`,
and per-table `matter.json` for Epicenter checkouts. Standalone Matter retains
its own format. A future explicit JSON export needs a concrete consumer; no
exporter, automatic generation, or fallback JSON reader is part of this work.

**Validation loads the explicitly selected folder's config once per invocation.**

The target command is `epicenter validate <folder> [--json]`. It imports exactly
`<folder>/epicenter.config.ts` in a fresh Bun process, uses the exported
definition's compiled field checks, and reads `kv.json` plus Markdown files
in its declared table directories. It does not search parent directories,
install dependencies, start a store, or load project configs when Desktop
browses a directory. No watcher or hot-reload lifecycle is introduced.
The supported launchers pass Bun's `--no-install` flag so runtime dependency
resolution cannot automatically fetch a missing package.

Missing config, missing dependencies, missing default export, thrown module or
compile errors, unreadable files, and malformed file input are command errors.
Use an error boundary around loading and validation; report file context and
preserve structured output under `--json`. Exit codes are 0 for conforming
input, 1 for conformance issues, and 2 for incomplete input or command errors.
Unknown fields remain readable and produce no issue merely for being undeclared.
Validation is not a Push preflight, permission check, or row-existence check.

Under `--json`, the CLI writes its report to stdout and redirects global
`console` diagnostics to stderr. On Bun 1.3.14, separately accessed builtin
console exports bypass that redirection, including named imports and namespace
access to `node:console`. The user accepted these as trusted-code exceptions,
alongside direct stdout writes and explicit process exit. Configs and their
dependencies must use global `console` or write diagnostics to stderr when JSON
output is required. Otherwise output can be invalid JSON even with exit code 0.
The CLI does not add loader hooks or subprocess isolation to control imported
code. Test global logging, builtin exports, thrown imports, and explicit process
exit; distinguish a reported failure from an aborted process.

Running validation executes trusted project code and its transitive imports.
There is no repeated confirmation prompt or sandbox promise. The command's own
validation logic does not write files, submit edits, or open persistence.
Imported code can have side effects; the whole invocation cannot be promised
read-only. Missing dependencies fail normally. Current private workspace
packages do not establish an installable public definition distribution.

Use the existing compiler's semantics, including its closed field recognition.
Do not introduce a handwritten second JSON Schema dialect to catch every
authoring mistake. Catching an exception does not detect constraints an
underlying library ignores. Fix demonstrated compiler defects in their owning
layer without claiming universal schema linting. Config execution does not
include automatic TypeScript typechecking.

**A lens grants no destination, persistence ownership, or write permission.**

The app developer chooses the lens shipped by that app. A folder author chooses
the config used by this tool. Changing either may change conformance diagnostics
without changing stored values. A config's definition ID describes the lens;
editing it cannot retarget an existing checkout.

The materialization manifest records the destination, managed table and row
paths, field baseline, and protected body fingerprints. Push uses those facts
and the receiving owner's permissions, independently of the mutable config.
Removing a table from the config must not hide its prepared edits from Push.
Adding a table cannot claim an unrelated directory. Config-only edits produce
no store edits and require no schema fingerprint or tampering refusal.

Pull and Push do not need to execute the local config. Pull obtains raw values
and body rendering from the running owner, whose definition can carry codecs.
Push parses captured files and submits permitted differences under ADR-0418.
Neither operation replaces the authored config. Creating or providing a
config is an explicit authoring step, separate from materializing store data;
a freshly pulled folder can be read and pushed before a config is provided,
but validation reports the missing config. Do not invent an import path to an
unpublished app package when scaffolding a folder.

**Markdown omission spells null; KV retains physical presence.**

Epicenter and Matter share `@epicenter/matter-core/parse`. Artifact framing
and JSON-compatible value checks remain at the file boundary. Malformed YAML,
duplicate keys, non-JSON values, and top-level YAML scalars refuse. Empty or
comment-only fenced YAML is an empty field map. Bodies remain opaque text.

For row comparison, omitted and explicit-null fields are equivalent.
Removing a populated row field assigns null. For row validation, supply null
for each omitted declared field and run its actual check. This includes JSON
fields whose schemas accept null without an explicit nullable wrapper.
Required strings still fail. This file interpretation does not relax presence
checks on stored rows or rewrite files. Empty strings, zero, and false retain
their values. Nested JSON remains one assigned field.

Every declared KV key must be present for conformance. Nullable allows a present
null; it does not make the key optional. Removing a key present in the baseline
deletes it, even when the deletion produces a conformance diagnostic. A key
absent from both baseline and file produces no write. A missing entire
`kv.json` is incomplete input, never delete-all.

**Shared parsing does not imply shared storage or editor capabilities.**

Standalone Matter files are authoritative. Epicenter files hold prepared edits
until Push through the running owner. Matter's current `matter.json` discovery
does not load `epicenter.config.ts`; generic checkout UI integration remains
unbuilt. Opening a checkout in an editor grants no body or protected-field
writes. Push refuses body differences and added or removed rows before mutation.

SQL is an optional derived read surface. A file index names its source and
refresh point; it does not change files or the baseline. Matter's schema and
query adapters are separate integration work, not a prerequisite for validation
or the first script-driven Pull/edit/Push workflow.

## Consequences

One authored source removes portable-schema admission, schema conversion,
generated-file precedence, regeneration, and freshness tracking. Working files
remain ordinary readable Markdown and JSON; validation requires executing the
config with its dependencies available.

Importing a definition can load more than field builders. Honeycrisp's current
definition imports its editor schema and Markdown codecs. Missing imports are
ordinary failures, and reducing those dependency graphs is separate work.

Only fields changed against the last Pull or successful Push become edits.
The manifest is durable local bookkeeping; an optional query index is disposable.
The validator does not open persistence. Imported code remains responsible for
its own effects and must not acquire a competing persistence owner.

## Considered alternatives

- Editable JSON as the default: requires another schema input boundary for a
  portability promise the user does not need.
- Explicit TypeScript-to-JSON generation: useful for a future consumer, but adds
  an exporter and a second validation input without a present requirement.
- Automatic generation: adds execution timing, stale outputs, and overwrite
  policy without simplifying the source of truth.
- Validate writes against the local lens: confuses interpretation with permission
  and rejects permitted edits the store can preserve.

## Verification

Exercise a freshly loaded config on each CLI invocation, including imported
definitions, missing packages, invalid exports, thrown errors, and config edits
between runs. Verify structured exit codes and that the validator itself creates
no metadata or writes. Use a side-effecting fixture to prove the documented
execution boundary rather than claim imported code is sandboxed.

Verify nullable KV absence versus present null, row omission versus null,
JSON-field null, undeclared values, malformed files, and unchanged baseline
fields. Config changes must neither grant writes nor retarget or hide managed
paths. Test Push and config preservation separately from validation. Run a real
Pull/title edit/durable Push before claiming the workflow ships.
