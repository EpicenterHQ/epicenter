# 0313. A data definition ships as TypeScript, and a host that needs one imports it

- **Status:** Accepted
- **Built**, and its admission half has since been deleted. `database.json` is gone from every build and every reader, which is this record's decision and stands. The host's table of imported first-party definitions, and the `data-open` verb that answered from it, were withdrawn by [ADR-0334](0334-a-deployed-app-is-a-trusted-app-because-deploying-it-was-the-consent.md): a deployed app is trusted, so there is no admission to perform. A definition still ships as TypeScript and an application still imports it.
- **Date:** 2026-08-31
- **Amends:** ADR-0296 at its reason for an optional codec. Its decision that a table owns its file codec is unchanged; what is withdrawn is the carve-out that a definition arriving as JSON cannot carry one.
- **Amends:** ADR-0210 at the file a declaration arrives in. The declaration itself, and the refusal of a permission grant, an installed-app registry, and publisher identity, are unchanged.
- **Relates:** ADR-0179 (superseded by ADR-0227; its refusal to read application source is what this record reverses, for first-party members only), ADR-0305 (which says admission and artifact trust need their own decision before a third-party plane ships, and this is not that decision), [ADR-0213](0213-a-lens-is-arktype-json-and-an-application-queries-only-its-own-projection.md) and [ADR-0240](0240-an-application-declares-one-workspace-and-an-opened-runtime-holds-exactly-one-definition.md) (a definition is inert and holds no storage or lifecycle, which stays true)
- **Relates:** [ADR-0316](0316-an-application-creates-one-scoped-epicenter-handle.md) (the application opens this definition through its scoped handle)

## Context

A data definition is authored in TypeScript, as a module-level constant built
from `field.*` and `defineTable`. It is then also emitted as `database.json`
into an app's build output, because one reader wanted it as data: the host
enumerating a catalog folder, deciding whether a directory is a member, and
learning the data id that addresses it.

That one reader is why three things are shaped the way they are.

`parseData` takes `unknown`. It is the compiler every opener calls to turn
field descriptors into `check` functions, and seven of its eight call sites
hand it a TypeScript object. The eighth hands it `JSON.parse` of a file, and
that call site is the whole reason the signature is not `DataDefinition`.

A codec is optional on a compiled table. ADR-0296 states the reason exactly:
"Absent when the definition arrived as JSON, which cannot carry a function."
Both artifact directions carry a refusal for it, so an export can fail because
a table declares a node with no codec to write it, and an import can fail
because a row file carries a body with no codec to read it.

And `database.json` is half the app output contract, beside `index.html`.

None of this is load-bearing any more. Nothing authors a definition as JSON.
The installed-app plane that made a folder untrusted is refused (ADR-0227), and
the future third-party catalog is explicitly a later decision (ADR-0305), so
every member a host reads today is first-party code from its own release.

## Decision

**A data definition ships as `database.ts`, which default-exports the value
`defineData` returned. A host that needs a definition imports the module.**

The host is Bun. Importing a first-party module from its own release is
ordinary, and it is what makes the definition a value rather than a
transcription of one.

**This reverses ADR-0179's refusal to read application source, and only for
first-party members.** A third-party artifact is not admitted this way and is
not admitted at all today. When that plane ships it needs its own decision
about admission and artifact trust, which ADR-0305 already says; executing a
stranger's module to learn its name is not a thing this record permits.

**`database.json` is deleted rather than kept as a fallback.** A second
spelling of a definition is a second thing to keep in step, and the reason for
the first one is the reason it existed at all.

## Consequences

- The compiler stops taking `unknown`. `parseData(value: unknown)` becomes a
  function over a `DataDefinition`, and the shape refusals it carries for
  untrusted input ("is it an object", "does it declare a kv section", "does it
  declare tables") go with the input that needed them. The CONTENT refusals
  stay: an id, a table name, a field name, and a schema carrying a default are
  strings and values that types do not check.
- Its name should change with its input. It lives in `compile.ts` and compiles;
  "parse" described the one caller that handed it text.
- **A codec becomes required on a compiled table**, and the two refusals that
  existed only for its absence go with it: an export of a node with no codec,
  and an import of a body with no codec. That is the largest deletion here and
  it is at a boundary a person's data crosses.
- The app output contract becomes `index.html` and `database.ts`. Admission
  reads the module instead of the file.
- A malformed definition now fails where every other TypeScript failure does,
  at the app's own build, rather than at the host's admission scan.
- The host executes first-party application code at admission. That is a real
  boundary move, recorded here rather than discovered later, and it is the
  clause a future third-party plane has to reopen.

## Considered alternatives

- **Keep `database.json` and generate it from `database.ts` at build time.**
  Rejected: it keeps every consequence above and adds a generator. The JSON
  would exist so that one reader can avoid an import it is allowed to make.
- **Have the host learn the data id from the directory name.** Rejected by
  ADR-0210: the directory an app arrives in is not an identity, and two
  directories may declare one data id.
- **Keep the optional codec anyway, for safety.** Rejected. An optional field
  with no way to be absent is a branch nothing reaches, and both refusals it
  guards are at the boundary where a person's files are read and written.
