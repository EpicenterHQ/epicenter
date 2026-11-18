# 0960. An app is a function of its folder, and a call has no hidden context

- **Status:** Proposed
- **Date:** 2026-11-18
- **Amends:** [ADR-0942](0942-a-home-is-one-bun-workspace-and-epicenter-is-a-dependency-of-it.md) at three points. The refusal of an app that resolves a second copy of `@epicenter/app` goes, and so does the alternative it kept, "the context stays". "Two packages are published, at one version" becomes one package: the command folds into `@epicenter/app`, and `@epicenter/cli` is retired. This reverses the two packages at one version from PR #2660. One install and one version line are unchanged.
- **Relates:** [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) (the first shape, `run(input, { folder })`), [ADR-0857](0857-an-app-is-one-epicenter-ts-that-composes-collections-and-actions.md) (the hidden run, which goes), [ADR-0949](0949-an-action-calls-a-model-with-plain-code-and-epicenter-adds-no-function-for-it.md) (no `env` or `model` function: an action reads `process.env`, so nothing but the folder reads the hidden run), [ADR-0959](0959-serve-loads-each-app-once-and-an-apps-code-changes-when-serve-restarts.md) (when the function is called), [ADR-0964](0964-a-folder-is-on-disk-and-it-holds-a-path-and-the-calls-that-change-files.md) (what the folder is, and the one a test passes).
- **Unbuilt:** All of it. `defineApp` takes an object, `folder` is an import that reads the run, and the copy check runs before every load. `@epicenter/cli` is still published beside `@epicenter/app`. `connect` in `packages/app/src/client.ts` does not yet accept a function app's type. The first thing to exist is a `defineApp` whose argument is a function of `{ folder }`.

## Context

An action reaches its app's folder through a value it never receives. The
<!-- doc-path-check: ignore-next-line (deleted when an app became a function of its folder, ADR-0960) -->
library keeps one `AsyncLocalStorage` in `packages/app/src/context.ts`. The
runner fills it with `inRun(context, work)`, and the imported `folder` and
every data handle read it. Outside a run they throw.

ADR-0857 chose this over `run(input, context)` for two reasons: every helper
needed the context passed on, and data defined at the top of the file could
not use it.

The value in that store never changes between calls. `load` in
`packages/app/src/command/home.ts` builds one context for an app, and `settle` in
`packages/app/src/command/run.ts` copies it for each call. A store made for values
that differ by request carries a value that is fixed for each app.

Keeping it has a price:

- The runner and the app must load the same copy of the library, or the app
<!-- doc-path-check: ignore-next-line (deleted with the copy check, ADR-0960) -->
  reads an empty store. `packages/cli/src/library.ts` exists to refuse an app
  that would load another copy.
- A test must wrap each call in `inRun`.
- The lifecycle cannot be read from an app's file: nothing in it shows where
  `folder` comes from.

The shared store is also why the command and the library are two packages
tied at one version (ADR-0942, PR #2660). `@epicenter/cli` names
`@epicenter/app` as a peer at its own exact version
<!-- doc-path-check: ignore-next-line (the command folded into packages/app and packages/cli was deleted, ADR-0960) -->
(`packages/cli/package.json`). `packages/cli/scripts/version.ts` writes one
version into both manifests, and `bun run check:versions` and
<!-- doc-path-check: ignore-next-line (the command folded into packages/app and packages/cli was deleted, ADR-0960) -->
`packages/cli/scripts/pack.ts` refuse while they differ. `libraryProblem` in
<!-- doc-path-check: ignore-next-line (deleted with the copy check, ADR-0960) -->
`packages/cli/src/library.ts` refuses to load an app on another copy or
another version. A home names both:
`"dependencies": { "@epicenter/cli": "0.7.0", "@epicenter/app": "0.7.0" }`.
Removing the store removes the reason for the load-time check, but the two
packages still have to agree on the input schema and the answer shape, and
`library.ts` is the only code that checks they match.

## Decision

**An app is a function. Whoever loads it calls it with its folder, and it
returns its description, data and actions.**

```ts
// apps/reading/code/epicenter.ts
import { defineAction, defineApp, defineData, field, Ok } from '@epicenter/app';

export default defineApp(({ folder }) => {
  const data = defineData(folder, {
    books: { description: 'book I am reading', fields: { title: field.text() } },
  });

  const log = defineAction({
    description: 'Record minutes read today',
    input: { minutes: field.number() },
    run: async ({ minutes }) => {
      await folder.edit('data/2026.csv', (before = 'minutes\n') =>
        Ok({ text: `${before}${minutes}\n` }),
      );
      return Ok({ minutes });
    },
  });

  return {
    description: 'How much I read each week',
    data,
    actions: { books: data.books.actions('list', 'get', 'create'), log },
  };
});
```

- **The folder is an argument.** `@epicenter/app` exports no `folder`, and
  `inRun` and the store behind it are removed. Code inside the function uses
  `folder` directly. A helper in another file takes it as a parameter.
- **The folder is the only thing passed.** ADR-0949 gives an action no `env`
  or `model` function: it reads `process.env` and calls a model with plain
  code. If a later record adds something a call must be handed, it arrives
  beside `folder`.
- **The folder still limits writes.** A write outside `data/` and `local/`
  throws. The check moves from the imported `folder` into the folder the
  loader builds.
- **What the folder holds is ADR-0964's.** `path`, `write` (text or bytes),
  `edit` and `delete`. An app and `defineData` read through
  `folder.path` with plain file calls.
- **A test passes a folder.** It calls the app with a folder on a temporary
  directory (ADR-0964) and calls an action on the result. A test can reach
  live records only by passing the live folder.
- **No copy check.** Nothing is shared in memory between the loader and the
  app, and the loader recognizes an action by its shape. `library.ts` and its
  call in `packages/app/src/command/home.ts` are deleted.

**The command and the library are one package, `@epicenter/app`, and
`@epicenter/cli` is retired.** The command's source moves from
`packages/cli/src/` into `packages/app/`, and `packages/app/package.json`
gains the bin:

```json
{
  "name": "@epicenter/app",
  "bin": { "epicenter": "./src/command/bin.ts" },
  "exports": { ".": "./src/index.ts", "./client": "./src/client.ts" }
}
```

- **What an Epicenter changes.** Its root `package.json` loses one line,
  `"@epicenter/cli": "x.y.z"`. No app file's import changes: every
  `epicenter.ts` already imports `@epicenter/app`, and `bun install` still
  puts `epicenter` in `node_modules/.bin/`.
- **What goes.** The peer dependency on `@epicenter/app` in
<!-- doc-path-check: ignore-next-line (the command folded into packages/app and packages/cli was deleted, ADR-0960) -->
  `packages/cli/package.json`; `packages/cli/scripts/version.ts`, with its
  `set-version` script and `sharedVersion`; `check:versions` in the root
  `package.json` and its place in `check:structure`; the version comparison
  in `library.ts`; the second tarball and the version check in `pack.ts`;
  and the upgrade step "edit both versions" in the command's README.
- **The release steps.** Set `version` in `packages/app/package.json`. Run
  `bun run --cwd packages/app pack`, which writes one tarball into a folder
  named for its content, because Bun caches a tarball by its path. Publish
  that one tarball, `--dry-run` first. An Epicenter upgrades by changing one
  version, then `bun install && bun run build` and a restart of serve.
- **The command's packages move with it.** `@modelcontextprotocol/sdk` joins
  `nanoid`, `typebox` and `wellcrafted` in the dependencies of
  `@epicenter/app`. `packages/app/src/client.ts` imports only `answer.ts`,
  `errors.ts`, `time.ts` and types from `action.ts` and `front-matter.ts`, so
  a UI bundle built from `@epicenter/app/client` holds no command or server
  code.

## Consequences

- Every app file is wrapped in one function. In the owner's Epicenter, about
  ten app files import `folder`, and 24 files call `inRun` or
  `createMemoryContext` at about 400 places; each changes.
- "Loading an app never touches its files" becomes a convention. Today
  `folder` throws outside a run. The function body could read a file while
  loading; it should not. Under ADR-0959 an app loads once, when serve
  starts, so a stray read costs one read per start. A loader could keep the
  rule by handing over a folder that throws until the function returns;
  nothing here adds that.
- A helper that touches files takes the folder as a parameter. This is the
  cost ADR-0857 named, limited to helpers outside the function.
- A UI imports the app as a type and writes `connect<typeof app>()`. With a
  function app, `connect` reads the function's return type, so no page
  changes. Only `connect`'s type parameter changes.
- The command and the library cannot be at two versions, so nothing checks
  that they match. The input schema and the answer shape are shared inside
  one package.
- Anything that installs only the library also installs the MCP SDK and the
  command's source. Inside an Epicenter that changes nothing, since both
  were installed. A UI bundle is unaffected, because the client imports no
  command code. A project outside an Epicenter that wants only `defineApp`
  pays the larger install.
- `@epicenter/cli` stops at its last published version. A registry page or a
  deprecation notice says to depend on `@epicenter/app`.
- Line count falls: roughly 110 lines leave `context.ts` and `library.ts`,
  `version.ts` goes, and `pack.ts` packs one package. `data.ts` is reshaped
  around the argument. The gain is that an app's file shows everything it
  depends on.
- The License section of `AGENTS.md` names `@epicenter/app` and
  `@epicenter/cli` as published at one version. It changes to name one
  package when this is built, as do the command's README sections "A home
  is a Bun workspace" and "Release", and the `epicenter-app` skill.
- ADR-0857 is `Proposed` and describes the hidden run. It is edited to match
  when this decision lands, not amended.

## Considered alternatives

- **The hidden run (ADR-0857).** App code is shortest: import `folder` and
  use it anywhere. It needs one shared copy of the library, a check that
  enforces it, and a wrapper in every test.
- **`run(input, { folder })` on each action (ADR-0841).** No hidden value.
  Data defined at the top of the file cannot reach the folder, and every
  action repeats the parameter. One function around the whole app gives the
  folder to everything inside it once.
- **Bind an app to the folder beside its code.** No argument at all, since
  the folder is found from the file's own path. A test could then no longer
  point an app at another folder, which is why ADR-0942 kept the context.
- **Keep the store in one global slot every copy shares.** Two copies of the
  library would then work together. Two versions could also run side by side
  with no error.
- **Keep two packages at one version (PR #2660).** A project that wants only
  the library installs less. With the copy check gone, nothing would make
  the two agree on the schema and the answer shape except the release
  habit, and an Epicenter would still name two versions it must keep equal.
  The library-only project has no caller today.
- **Fold the library into `@epicenter/cli`.** One package as well, but every
  app's import changes from `@epicenter/app` to the new name. ADR-0942
  refused one package for that cost; folding the other way has none.
