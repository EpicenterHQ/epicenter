import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import {
	defaultClientConditions,
	mergeConfig,
	searchForWorkspaceRoot,
	type UserConfig,
} from 'vite';
import { isHostAppBuild } from './host-app.js';

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
 * An app that needs more settings adds them with `mergeConfig`, which
 * concatenates arrays rather than replacing them.
 */
export function workspaceAppViteConfig(app: { port: number }): UserConfig {
	return {
		// Bun can split `vite` into peer-variant installs (`vite@7.3.5+<hashA>`
		// vs `+<hashB>`), which makes identical `Plugin` types compare unequal
		// across app configs. Keep the cast here, the one place every workspace
		// app's plugins come from, instead of leaking the workaround into each app.
		// SAFETY: both values are Vite plugins; only their peer-variant types differ.
		plugins: [sveltekit(), tailwindcss()] as UserConfig['plugins'],
		// No `resolve.dedupe` here. It named `yjs` for a long time, which no
		// workspace member depends on since the store moved to `@y/y`, so it was
		// inert. Retargeting it at `@y/y` is worse than inert: `dedupe` resolves
		// from the app root, and an app that reaches the CRDT only through
		// `@epicenter/app/store` does not declare it, so Rollup fails the production
		// build with an unresolved import. One install is what actually keeps
		// CRDT identity, and the lockfile is where that is enforced.
		server: {
			port: app.port,
			strictPort: true,
			fs: { allow: [searchForWorkspaceRoot(process.cwd())] },
		},
	};
}

/**
 * Base Vite config for a folder app Epicenter bundles: `workspaceAppViteConfig`
 * plus the choice between its host build (`EPICENTER_HOST=1`, see
 * `isHostAppBuild`) and its browser build. An app adds its own settings
 * with `mergeConfig`.
 *
 * - The host build turns on the `epicenter-host` condition, which selects
 *   the host leaf of each `#platform/*` seam in the app's package.json
 *   "imports". The `...defaultClientConditions` spread is load-bearing:
 *   custom conditions REPLACE Vite's defaults.
 * - Shared code imports a folder contract from `@epicenter/folder`. The host
 *   build selects its Tauri entry. The portable build keeps the runtime choice
 *   so the same bytes can run in a browser or a hosted Epicenter window.
 * - `import.meta.env.EPICENTER_HOST` is `'1'` in the host build, which
 *   each app's `src/routes/+layout.ts` reads to prerender every page.
 *
 * The answer is read when this is called, so a process that sets
 * `EPICENTER_HOST` before importing the app's `vite.config.ts` gets the build
 * it asked for (`scripts/module-graph.ts` does).
 */
export function hostAppViteConfig(app: { port: number }): UserConfig {
	const host = isHostAppBuild();
	return mergeConfig(workspaceAppViteConfig(app), {
		resolve: {
			...(host && {
				conditions: ['epicenter-host', ...defaultClientConditions],
			}),
			alias: [
				...(host
					? [
							{
								find: /^@epicenter\/folder$/,
								replacement: '@epicenter/folder/tauri',
							},
						]
					: []),
			],
		},
		define: {
			'import.meta.env.EPICENTER_HOST': JSON.stringify(host ? '1' : ''),
		},
	} satisfies UserConfig);
}
