---
name: sveltekit
description: Apply SvelteKit patterns for routing, server modules, form actions, hooks, cookies, adapters, and invalidation. Use when editing route files, hooks, `app.d.ts`, or SvelteKit behavior.
metadata:
  author: epicenter
  version: '1.0'
---

# SvelteKit

## Reference Repositories

- [SvelteKit](https://github.com/sveltejs/kit) - Svelte application framework for routing, server rendering, form actions, and adapters
- [Svelte](https://github.com/sveltejs/svelte) - Svelte 5 compiler and runtime

## Upstream Grounding

When SvelteKit load behavior, invalidation, cookies, hooks, env handling, server-only modules, generated `$types`, or adapter behavior affects correctness, ask DeepWiki a narrow question against `sveltejs/kit` before relying on memory. Verify decisive details against local installed types and source.

Use the `svelte` skill for component runes and template mechanics.

## Server Versus Universal Code

- Use `+page.server.ts` or `+layout.server.ts` for secrets, database access, auth, cookies, and `locals`.
- Use universal `+page.ts` or `+layout.ts` only for client-safe data and behavior.
- Keep server-only code in `$lib/server`, `.server` modules, `hooks.server.ts`, `+server.ts`, or server route files.
- Server `load` return values must be serializable.
- Do not store shared mutable request state in server modules or `load` functions. Put per-request state in `event.locals`.

## Loading, Invalidation, And Forms

- Use `depends`, `invalidate`, `invalidateAll`, and `untrack` deliberately. Do not assume server fetches are invalidation-trackable unless the dependency is explicit.
- Define form actions in `+page.server.ts`.
- Use `fail()` for validation failures so the page keeps form state and status.
- Use `use:enhance` only for `POST` forms.
- Put auth and session lookup in `hooks.server.ts`, then expose the request result through `event.locals`.

## Types And Boundaries

- Use `$lib` from routes to reach modules under the app’s `src/lib`.
  Use relative imports for files that live together, such as a route
  and its companion component. Import shared packages through their
  public exports.
- Import generated route types from `./$types` in route files.
- Keep env reads in server code unless the value is intentionally public.
- Keep redirects and errors explicit with SvelteKit helpers so status codes survive SSR and client navigation.
