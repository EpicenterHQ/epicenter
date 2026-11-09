# epicenter

The source of the apps in `~/Epicenter` (ADR-0864). Each folder here is one
app: `epicenter/capture` is what `bun epicenter/install.ts capture` puts into
`~/Epicenter/capture`.

```txt
epicenter/capture/
  epicenter.json        the app's declaration: its collections
  epicenter.ts          its actions beyond each collection's four
  src/, static/         its view: SvelteKit, Svelte 5, and @epicenter/ui
```

`bun epicenter/install.ts <app>` makes `~/Epicenter/<app>` with
`epicenter new` the first time, copies `epicenter.json` and `epicenter.ts`
and commits them alone as `install <app>`, and builds the view into the app's
`views/`, which the app's `.gitignore` keeps out of its history. It never
touches the app's data. `HOME` decides `~`, so a test installs into a
temporary folder.

`epicenter serve` serves an app's `views/` at `/<app>/` and MCP at `/mcp`. A
view asks for everything through `connect('<app>')` from
`@epicenter/app/client`, and keeps nothing of its own. In development,
`bun run dev` in an app's folder proxies `/mcp` to a running
`epicenter serve` (`EPICENTER_URL`, default `http://127.0.0.1:4747`).

A view is a static SvelteKit build with hash routes (`#/c/<id>`), so the
server serves files and routes nothing. Install builds it with
`VIEW_BASE=/<app>`, the path `epicenter serve` mounts it at.
