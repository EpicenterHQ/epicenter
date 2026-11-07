# 0841. An app is a folder whose `epicenter.ts` defines its actions

- **Status:** Proposed
- **Date:** 2026-11-07
- **Relates:** [ADR-0840](0840-epicenter-is-where-one-persons-software-lives-and-the-folder-sync-product-waits.md) (the direction), [ADR-0827](0827-the-cli-and-mcp-render-one-table-of-operations.md) (one table, rendered twice).
- **Spec:** [specs/20261107T222922-epicenter-is-where-personal-software-lives.md](../../specs/20261107T222922-epicenter-is-where-personal-software-lives.md)
- **Unbuilt:** all of it: `@epicenter/app` with `defineApp` and `field`; discovery and per-app commands in `epicenter`; actions as MCP tools.

## Context

ADR-0840 makes Epicenter the home of one person's apps and the agents that use
them. An app needs a name, a list of things it can do with typed input, an
implementation for each, and somewhere to keep its data. The CLI already renders
one description of an operation as a command and as an MCP tool
(`packages/cli/src/operation.ts`); apps need the same, without writing a command
or a tool by hand.

## Decision

**An app is a folder containing `epicenter.ts`.** The folder's name is the app's
name. Its code and its data live together in it.

```ts
// ~/Epicenter/reading/epicenter.ts
import { defineApp, field } from '@epicenter/app';

export default defineApp({
  description: 'How much I read each week',
  actions: {
    log: {
      description: 'Record minutes read today',
      input: { minutes: field.number(), book: field.text({ optional: true }) },
      run: async ({ minutes, book }, { folder }) => { /* write under folder */ },
    },
  },
});
```

- **An action** is a key in `actions` with a `description`, an `input` that is a
  plain record of fields, and `run(input, { folder, cache, secrets })`.
- **`folder`** is the app's folder: in Git, readable. **`cache`** is
  `~/Library/Caches/Epicenter/<app>/`: anything that can be rebuilt. **`secrets`**
  reads and writes the Keychain under `epicenter.<app>`; secrets never touch a
  file.
- **`run` returns a value.** The CLI prints it, as JSON with `--json`; an agent
  receives the same value.
- **`field`** is `text`, `number`, `boolean`, `select`, `tags`, and `date`, each
  taking `{ optional, description }`, all TypeBox underneath. A field says what
  a form draws, what `--help` lists, and what MCP's schema allows. Raw TypeBox
  remains for anything else.
- **Discovery is the filesystem.** Inside an app's folder, `epicenter` is that
  app: `epicenter log --minutes 30`. Anywhere else it is `~/Epicenter`, whose
  child folders with an `epicenter.ts` are its apps: `epicenter reading log`.
  Bare `epicenter` lists the apps and actions where it stands.
- **Every action is a command and a local MCP tool** (`epicenter mcp`, stdio).
  `readOnly` and `destructive`, mapped to MCP's hints, are added to an action
  when a surface first needs them.
- **A UI calls actions; it never writes files itself.** A page imports the app's
  type, not its code, and calls actions through `epicenter serve`; forms come
  from the fields.

## Considered alternatives

- **`app.ts`.** Collides with files in existing code folders, so every Svelte
  project would look like an app. `epicenter.ts` names the tool, as
  `package.json` and `justfile` do.
- **A registry** (`epicenter.config.ts` exporting a list, or `epicenter add` and
  `forget` remembering paths). The folder already says what it is; a list can go
  stale.
- **Code apart from data.** Protects data history from rebuilt code and lets one
  app open many folders; neither matters for a small personal app edited on
  purpose.
- **`operations`, `commands`, `tools`.** Each names one surface or a programmer's
  view. `actions` is what Apple's App Intents and the author's own notes call
  what an app offers.
- **`summary` with a `title`.** `description` is the word MCP, JSON Schema, and
  agents use; the key is already a title.
- **An `op()` wrapper, or places given to a factory.** TypeScript 5.9 infers
  `run`'s input from a plain record passed to `defineApp`, but not through a
  factory; places as `run`'s second argument need neither.
- **`Type.Object` for input.** Says nothing a form or `--help` can use.

## Consequences

- Writing an app is writing one file; asking an agent for an app is asking it to
  write one.
- The vault becomes an app where it stands, by gaining an `epicenter.ts`.
- A published app is a folder whose `epicenter.ts` is one line re-exporting a
  package.
