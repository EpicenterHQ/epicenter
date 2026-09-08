# @epicenter/constants

Shared Epicenter platform contracts: the facts several packages and apps must agree on but none can own, so they live below all of them. Each runtime context gets its own subpath export, so bundlers only pull in what they need.

This is a floor, not a junk drawer. A fact belongs here only when more than one package (or app) needs it and no single one is its natural owner. Single-owner values live beside their owner instead: HTTP error unions live in `@epicenter/server` and the billing layer, the store sync route lives in `@epicenter/sync`, and the release version lives in `apps/landing`.

## Exports

### `@epicenter/constants/apps`

The app origin and port registry (`APPS`), plus the origin helpers CORS and sign-in callback approval derive from it (`localUrl`, `appOrigins`, `prodOrigins`) and the Node API-base default (`EPICENTER_API_URL`). Exact callback paths are approved by the hosted auth configuration, separately from trusted origins.

```typescript
import { APPS, appOrigins } from '@epicenter/constants/apps';
```

### `@epicenter/constants/vite`

Flat `APP_URLS` resolved at Vite build time (dev localhost vs prod origin, via `import.meta.env.MODE`). For Vite-bundled apps (SvelteKit, Astro, Tauri, WXT).

```typescript
import { APP_URLS } from '@epicenter/constants/vite';

const apiUrl = APP_URLS.API; // dev: http://localhost:8787 · prod: https://api.epicenter.so
```

### `@epicenter/constants/api-routes`

`API_ROUTES`: the shared home for API route contracts whose domain has no dedicated shared package (the session projection, the blob store, the `/v1` inference gateways). Each leaf carries the server `pattern`, an optional server-only `prefixPattern` mount helper, and the client `url(...)` builder. Not a registry of every route: routes whose domain owns a shared package live there. `@epicenter/sync` owns the store sync route (`STORE_SYNC_ROUTE`), because a browser replica builds that URL and has no business importing a server to learn it.

### `@epicenter/constants/ai-providers`

The sellable-model catalog (`AI_MODELS`) and its derivations (`AiProvider`, `MODELS_BY_ID`, `providerLabel`, `toHostedCatalog`). Shared by the server inference gateway (routing), the billing layer (pricing), and the chat apps (model pickers).

## Adding a new app

1. Add an entry to `APPS` in `src/apps.ts` with `port` and `url`.
2. Every consumer picks it up automatically: TypeScript enforces completeness.
