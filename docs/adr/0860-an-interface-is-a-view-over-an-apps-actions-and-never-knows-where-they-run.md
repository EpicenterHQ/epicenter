# 0860. An interface is a view over an app's actions, and never knows where they run

- **Status:** Proposed
- **Date:** 2026-11-09
- **Relates:** [ADR-0849](0849-your-server-is-one-always-reachable-computer-that-runs-named-actions.md) (your server, and reach from vendors' clouds), [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (programs that have the folder or ask), [ADR-0853](0853-collections-give-five-actions-and-programs-without-the-folder-ask-over-mcp.md) (MCP, the view client), [ADR-0857](0857-an-app-is-one-epicenter-ts-that-composes-collections-and-actions.md) (`epicenter.ts`, and the client typed by it), [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (one copy, and `serve` at `/<app>/` and `/`).
- **Unbuilt:** `epicenter build` bundling `ui/index.html` with Bun when `ui/package.json` has no `build` script (today such a `ui/dist/` is written by hand and committed); a build that replaces the last one only once it is complete; relative asset paths (the starters' base is `/<folder name>/`); records under `data/` (ADR-0876). HTTPS is not `serve`'s: it comes from `tailscale serve` on the tailnet and from an HTTPS tunnel to the public listener. Built: `epicenter serve` serving the view at `/<app>/` and MCP at `/` (`packages/cli/src/http.ts`); the view client `connect`, typed by the app (`packages/app/src/client.ts`); Capture's, Reading's, Tasks', and Vocab's views in `apps/<app>/ui/`, which `epicenter new --from`, `update`, and `build` build into `ui/dist/` (ADR-0866), and a hand-written `ui/dist/` when `ui/package.json` has no `build` script (`packages/cli/src/ui.ts`); the public listener, behind a sign-in, for an HTTPS tunnel (ADR-0871).

## Context

The author wants interfaces made for one app (a list of captures, a Vocab
practice card) as well as Claude and the terminal, without a second system
beside actions. The Vocab in this repository is local-first: its own store,
sign-in, model picker, tutor chat, and dictation, most of which Claude already
has. `epicenter serve` holds the one copy of each app and answers MCP at `/`
(ADR-0864), so any page that can reach that address can ask for the app's
actions as an agent does.

## Decision

**An app's interfaces are views, and a view is a web client of its app's
actions.** A view is static files with hash routes (`#/c/<id>`) built into the
app's `ui/dist/`, and `epicenter serve` serves them at `/<app>/` on the same origin as
MCP at `/`. It reads and changes the app only by calling the app's actions
through `connect<typeof app>()` (ADR-0853). The server routes nothing and runs
nothing for a view.

```txt
~/Epicenter/capture/
  epicenter.ts        its collections and actions
  ui/                 the view's source: any build, or one index.html
  ui/dist/            the built view, served at /capture/, ignored by ui/.gitignore
  data/captures/<time>.md
```

**A view is what `ui/` builds to, and it is always built.** `epicenter serve`
serves `ui/dist/` at `/<app>/` and looks nowhere else. `ui/dist/` is
rebuildable, ignored by `ui/.gitignore`, and never committed (ADR-0854).
`epicenter build`, `new --from`, and `update` build it:

- When `ui/package.json` has a `build` script, they install from the UI's
  committed `bun.lock` and run it. `dist` is the default output of Vite,
  Astro, Parcel, and Rsbuild; SvelteKit's static adapter is pointed at it with
  `adapter({ pages: 'dist', assets: 'dist' })`.
- Otherwise they bundle `ui/index.html` with Bun's bundler, which `epicenter`
  carries, so a single `index.html`, with TypeScript, TSX, and CSS beside it,
  is a view with no `package.json` and no setting.

A build writes beside the last view and replaces it only once it is complete,
so `serve` never answers from half a build, and a failed build leaves the last
view in place. A view refers to its own files by relative paths and routes
with the hash, so the same build works under any folder name. Any build that
produces static files works; SvelteKit with Epicenter's components is the
default starter, not a requirement.

**A view follows four rules.**

1. It holds nothing that must survive it closing, and no rule an agent or the
   terminal would need. A card being shown or a draft not yet sent is the
   view's; saved data is in the folder and rules are in actions, so whatever a
   view can do, an agent and the terminal can do.
2. Only what needs the device stays in a program: the microphone, a global
   shortcut, pasting. Everything else is an action.
3. Each step up the ladder below names what the step beneath could not do.
4. It speaks MCP to `epicenter serve` and nothing else. A view that needs
   something that is not an action gets a new action.

**The interface ladder.**

| Rung | Interface | Steps up when |
| --- | --- | --- |
| 1 | text: the terminal, Claude, Claude Code, ChatGPT | a person wants to see or tap, not type |
| 2 | a view, in a browser on any device that reaches your server | it needs the device in a way a browser does not give |
| 3 | a program of its own with a copy of the folder (Whispering), which writes files and commits | never |

**A view never knows where actions run.** It calls an action by its words, and
`epicenter serve` runs it: a collection's verb or a written action, from the
`epicenter.ts` of a repository the server's operator trusts (ADR-0864). A view
served from somewhere other than the server passes the server's address to
`connect`.

## Consequences

- A view written once works in a browser on the Mac, the laptop, and the phone,
  and the browser sandboxes it.
- A view works only while your server is reachable; it keeps nothing offline.
- A view sees no change it did not ask for: after an action it asks again.
- Views share one origin and the server's sign-in, so a view can call any
  app's actions, not only its own app's.
- Only the computer that serves a view holds its built files; they are rebuilt
  from source after a change.
- The rebuilt Vocab starts at rung 1, with Claude as the tutor, and gains a view
  when Claude is not enough.

## Considered alternatives

- **A view as an MCP App, one HTML file that a host such as Claude Desktop
  renders in a sandboxed frame and that calls tools through the host by
  `postMessage`.** MCP Apps is MCP's first official extension (stable
  2026-01-26), and a spike on 2026-11-09 passed its whole exchange with the
  SDK's own host. Such a view opens only inside a host that renders MCP Apps,
  and claude.ai and Claude's phone apps do that only for connectors added by
  URL; a page at `/<app>/` opens in any browser.
- **One Epicenter app hosting every app's views, with a palette of actions and
  forms drawn from input schemas.** A program on every device holding a copy of
  each app (ADR-0864 deletes it).
- **The Epicenter app hosting interfaces through an API of its own (ADR-0852's
  rejected alternative).** Rebuilds the platform layer the earlier Mail died of,
  and makes Epicenter a gate.
- **A sync engine giving each view a local replica (Replicache, Zero).** Instant
  and offline, and it is the folder sync product that waits (ADR-0840).
- **An RPC or REST API for views.** A second protocol beside MCP, which agents
  already speak.
- **Actions in the browser, with the folder in browser storage.** Git, LFS, and
  sign-ins in a browser, which is the product that waits.
- **Actions in a Durable Object.** Epicenter would run and sandbox other
  people's code and hold their tokens (ADR-0864).
- **"Screen" or "interface" as the noun.** A view need not fill a screen, and
  `interface` already means something in TypeScript.
- **Serving `ui/` itself when it has no build, and `ui/dist/` when it has
  one.** A hand-written view would sit at the top of `ui/`, but `serve` would
  choose between two folders, and a project not yet built would serve its
  source `index.html` as a broken page instead of no view.
- **`ui/build/`.** SvelteKit's static adapter writes there by default, but
  Vite and most other tools write `dist/`, and the default starter is the one
  project that changes a setting.
