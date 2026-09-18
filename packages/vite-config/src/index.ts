import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { searchForWorkspaceRoot, type UserConfig } from 'vite';

/**
 * Base Vite config for SvelteKit workspace apps whose package contract and
 * browser composition live at the app root, outside `src/`.
 *
 * The `fs.allow` entry is load-bearing, but not because of Vite's own
 * default. @sveltejs/kit's plugin sets fs.allow to the app `src/`, the app and
 * workspace-root `node_modules`, and its own output, and nothing else. That
 * omits the monorepo root, so the app-root composition files (the package
 * contract and browser entry that live outside `src/`) and sibling-package
 * source are unreadable in dev. Adding the workspace root restores both; Vite
 * concatenates it with SvelteKit's entries rather than replacing them. It is
 * also what lets a worker declared inside a workspace package load at all: its
 * `new URL('./x.worker.ts', import.meta.url)` resolves to a `/@fs/` URL under
 * the monorepo root, which SvelteKit's list answers 403 to.
 *
 * **The last three are what `@epicenter/device`'s browser leaf costs.**
 * Only `apps/local-mail/ui` composes it, so they belong in that app's config
 * rather than here; they stay until that move is made. Its SQLite owner is a
 * dedicated worker over `@sqlite.org/sqlite-wasm`, because OPFS synchronous
 * access handles exist only in a worker context, so:
 *
 * - `optimizeDeps.exclude` keeps the package unbundled. It resolves
 *   `sqlite3.wasm` relative to its own module URL, and pre-bundling rewrites
 *   that URL into `.vite/deps/`, where no `.wasm` was copied. The fetch then
 *   falls through to the SPA fallback and the module aborts on a `text/html`
 *   response.
 * - `worker.format` makes the worker chunk ES output, which it has to be to
 *   carry that package at all.
 * - `build.target` admits the syntax that chunk uses, top-level `await`
 *   included.
 *
 * An app that needs more exclusions adds them; `mergeConfig` concatenates the
 * arrays rather than replacing them.
 */
export function workspaceAppViteConfig(app: { port: number }): UserConfig {
	return {
		// Bun can split `vite` into peer-variant installs (`vite@7.3.5+<hashA>`
		// vs `+<hashB>`), which makes identical `Plugin` types compare unequal
		// across app configs. Keep the cast here, the one place every workspace
		// app's plugins come from, instead of leaking the workaround into each app.
		plugins: [sveltekit(), tailwindcss()] as UserConfig['plugins'],
		// No `resolve.dedupe` here. It named `yjs` for a long time, which no
		// workspace member depends on since the store moved to `@y/y`, so it was
		// inert. Retargeting it at `@y/y` is worse than inert: `dedupe` resolves
		// from the app root, and an app that reaches the CRDT only through
		// `@epicenter/data` does not declare it, so Rollup fails the production
		// build with an unresolved import. One install is what actually keeps
		// CRDT identity, and the lockfile is where that is enforced.
		server: {
			port: app.port,
			strictPort: true,
			fs: { allow: [searchForWorkspaceRoot(process.cwd())] },
		},
		optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
		worker: { format: 'es' },
		build: { target: 'esnext' },
	};
}
