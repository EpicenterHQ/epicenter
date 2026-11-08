# Apps

The apps in this directory have different roles. Whispering is a person-facing
app. Local Books runs a QuickBooks mirror. The API provides sign-in, folder
routes, AI, billing, and the dashboard. Landing and the PostHog reverse proxy
are deployed infrastructure.

| App | Role | Run from the repository root |
| --- | --- | --- |
| [Whispering](whispering/README.md) | Voice notes in a browser or desktop window | `bun dev:whispering` |
| [Local Books](local-books/README.md) | QuickBooks data in local SQLite | See its README |
| [API](api/README.md) | Hosted API and dashboard | `bun dev:api` or `bun dev:api-dashboard` |
| [Landing](landing/README.md) | Public site | `bun dev:landing` |
| [PostHog reverse proxy](posthog-reverse-proxy/README.md) | Analytics proxy | `bun dev:posthog-reverse-proxy` |

## Current application composition

Whispering's current code opens a folder through `@epicenter/folder` and reads
its contract from `src/lib/contract.ts`. Its `src/lib/app.ts` opens capabilities
once and adapts them for Svelte through `reactive`. On the web, the folder is
attached to the signed-in account on the server. In a Tauri window, the files
live in a folder on the computer. The same page build runs on both surfaces.
[Whispering's README](whispering/README.md) describes its file layout, startup,
and differences between the web and desktop builds.

The next app model is a folder whose `epicenter.ts` defines actions for the
`epicenter` CLI. [ADR-0840](../docs/adr/0840-epicenter-is-where-one-persons-software-lives-and-the-folder-sync-product-waits.md)
sets that direction; [ADR-0841](../docs/adr/0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md)
defines the folder and action shape. The current app code and package READMEs
show what still runs while that model is built.
