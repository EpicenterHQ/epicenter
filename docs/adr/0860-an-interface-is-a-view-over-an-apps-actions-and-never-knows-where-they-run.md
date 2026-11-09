# 0860. An interface is a view over an app's actions, and never knows where they run

- **Status:** Proposed
- **Date:** 2026-11-09 (amended 2026-11-09 by [ADR-0863](0863-epicenter-is-one-place-and-one-app-shows-it-on-every-device-you-own.md): the Epicenter app holds a copy of each app on a Mac and a phone and runs views against it; a browser runs no actions; a view may hold state that need not survive it)
- **Relates:** [ADR-0849](0849-your-server-is-one-always-reachable-computer-that-runs-named-actions.md) (your server, and reach from vendors' clouds), [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (programs that have the folder or ask), [ADR-0853](0853-collections-give-four-actions-and-programs-without-the-folder-ask-over-mcp.md) (MCP, the typed client), [ADR-0857](0857-an-app-declares-itself-in-epicenter-json-and-its-code-in-epicenter-ts.md) (actions in `epicenter.ts`), [ADR-0863](0863-epicenter-is-one-place-and-one-app-shows-it-on-every-device-you-own.md) (the place and the Epicenter app).
- **Unbuilt:** all of it: `views/`, `view` on an action, `ui://` resources in `serve`, and the Epicenter app.

## Context

The author wants interfaces made for one app (a Vocab practice card, a phone
page) as well as Claude and the terminal, without a second system beside
actions. The Vocab in this repository is local-first: its own store, sign-in,
model picker, tutor chat, and dictation, most of which Claude already has.
MCP Apps, MCP's first official extension (stable 2026-01-26), lets a tool name
an HTML resource (`ui://…`) that a host renders in a sandboxed frame; the frame
is an MCP client that calls the server's tools through the host over
`postMessage`, and a host without the extension shows the tool's text result.
Claude's web and desktop apps, VS Code, and Goose are hosts.

## Decision

**An app's interfaces are views, and a view is an MCP App.** A view is one HTML
document, which may be a whole single-page app built into one file, kept under
`views/` in the app's folder. It reads and changes the app only by calling the
app's actions through the host that shows it. `epicenter serve` offers
`views/practice.html` of Vocab as the resource `ui://vocab/practice` with
MIME type `text/html;profile=mcp-app`.

```txt
vocab/
  epicenter.json
  epicenter.ts            an action may name a view
  views/practice.html     calls Vocab's actions, holds nothing
  entries/serendipity.md
```

```ts
export const practice = action({
  description: 'Pick up to three New words to practise',
  view: 'practice',
  run: async (_, { collections }) =>
    (await collections.entries.list()).filter((e) => e.stage === 'new').slice(0, 3),
});
```

**An action may name a view,** which becomes its tool's
`_meta.ui.resourceUri`. A host that renders views shows the view with the
action's result; any other shows the result as text, so every view still works
from the terminal and Claude Code. Opening a view needs no action in a host
that lists views itself.

**A view follows four rules.**

1. It holds nothing that must survive it closing, and no rule an agent or the
   terminal would need. A card being shown or a draft not yet sent is the
   view's; saved data is in the folder and rules are in actions, so whatever a
   view can do, an agent and the terminal can do.
2. Only what needs the device stays in a program: the microphone, a global
   shortcut, pasting. Everything else is an action.
3. Each step up the ladder below names what the step beneath could not do.
4. It speaks MCP through the host and nothing else. A view that needs something
   that is not an action gets a new action.

**The interface ladder.**

| Rung | Interface | Steps up when |
| --- | --- | --- |
| 1 | text: the terminal, Claude, Claude Code | a person wants to see or tap, not type |
| 2 | the Epicenter app, on a Mac or a phone: every app's actions in a command palette, `list` and `get` as tables, the rest as forms from their input schemas | a form and a table cannot do it |
| 3 | a view, shown by Claude or the Epicenter app | it needs the device in a way the Epicenter app does not give |
| 4 | a program of its own with the folder (Whispering), which writes files and commits | never |

**The Epicenter app is a host like Claude.** It lists every app's actions and
views, and opens a view full screen, on a Mac and on a phone (ADR-0863). It
holds a copy of each app, so a view there runs the app's collections against
local files, offline included; on a Mac it also reaches `epicenter.ts` through
`epicenter`. A view runs in a sandboxed iframe and talks to its host only by
`postMessage`; the host checks where each message came from and never lets a
view call its native commands. A view is one HTML file however it is made: a
plain file, or a project whose build produces one file; Svelte with
Epicenter's components is the default template, not a requirement. Claude
Desktop shows views from a server it starts over stdio, so `ssh studio
epicenter serve --stdio` reaches it now. claude.ai and Claude's phone apps show
views only from connectors added by URL, which need a public address with a
sign-in (ADR-0849) and wait.

**A view never knows where actions run.** It speaks MCP over whichever
transport its host gives it, and an action reaches data only through
`{ collections, folder, secrets }` and the network. `origin` is the truth, and
every place that runs actions holds a clone of it that commits and syncs
(ADR-0851, ADR-0863). A browser runs none.

```txt
transport                      runtime                                   when
postMessage, through Claude    epicenter over stdio, here or ssh studio  now, in Claude Desktop
in the same process            the Epicenter app with its copy           collections, on a Mac and a phone
stdio, from the Epicenter app  epicenter on this Mac                     epicenter.ts, on a Mac
HTTPS                          your server's epicenter serve             a browser, claude.ai, Claude on the phone
```

## Consequences

- A view written once is shown by Claude in a conversation, by the Epicenter app
  on a phone, and as text in a terminal.
- A view sees no change it did not ask for: after an action it asks again. MCP's
  resource subscriptions may make collections live later.
- A view works offline in the Epicenter app, which holds the app's files; in
  Claude and in a browser it needs its runtime reachable.
- An action that uses only its context runs wherever `epicenter` runs; one that
  imports `node:fs` or calls a Bun API runs only on a computer.
- Claude sees every app through one server, so a view shown there can call any
  app's actions, guarded by the host's approval. The Epicenter app gives a view
  only its own app's actions.
- An action meant only for views can carry MCP Apps' `_meta.ui.visibility:
  ["app"]`, which hides it from the model, when an app first needs one.
- Verified 2026-11-09: Anthropic's MCP Apps guide connects its example
  servers to Claude Desktop over stdio and shows them inline after the person
  allows it. A spike server (`@modelcontextprotocol/sdk` 1.32.2,
  `@modelcontextprotocol/ext-apps` 1.7.5) offering `ui://vocab/practice` passed
  the whole exchange with the SDK's own host, without a browser: the host's
  `io.modelcontextprotocol/ui` capability, the resource read, `ui/initialize`,
  the tool result reaching the view, and the view's `tools/call` changing the
  server's state. Not yet seen: a view drawn in Claude Desktop from
  `epicenter serve`.
- A view's data arrives as the action's `structuredContent`; Claude drops a
  result over about 150,000 characters, so an action that opens a view returns
  what the view shows, not the whole collection.
- The rebuilt Vocab starts at rung 1, with Claude as the tutor, and gains a view
  when Claude and the Epicenter app's forms are not enough.

## Considered alternatives

- **Screens: pages of the app's own that call `serve` over HTTP.** The same
  rules, but no conversation can show them, and the protocol between page and
  host would be Epicenter's own.
- **The Epicenter app hosting interfaces through an API of its own (ADR-0852's
  rejected alternative).** Rebuilds the platform layer the earlier Mail died of,
  and makes Epicenter a gate. MCP Apps is that layer as a standard, with hosts
  Epicenter does not own.
- **A sync engine giving each view a local replica (Replicache, Zero).** Instant
  and offline, and it is the folder sync product that waits (ADR-0840).
- **An RPC or REST API for views.** No host renders it, and it is a second
  protocol beside MCP.
- **Actions in the browser, with the folder in browser storage.** Git, LFS, and
  sign-ins in a browser, which is the product that waits.
- **Actions in a Durable Object.** Workers cannot run Git, so the runtime would be
  written twice; a container runs the same `epicenter`.
- **"Screen", "page", or "interface" as the noun.** A card in a conversation is
  not a screen, a page is only the web, and `interface` already means something
  in TypeScript. "View" is MCP Apps' own word.
