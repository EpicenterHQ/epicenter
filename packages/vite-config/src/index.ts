import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import {
	defaultClientConditions,
	defaultServerConditions,
	type EnvironmentModuleNode,
	type Plugin,
	searchForWorkspaceRoot,
	type UserConfig,
} from 'vite';

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
		plugins: [
			sveltekit(),
			tailwindcss(),
			reloadWhenAppChanges(),
		] as UserConfig['plugins'],
		// No `resolve.dedupe` here. It named `yjs` for a long time, which no
		// workspace member depends on since the store moved to `@y/y`, so it was
		// inert. One install is what keeps a package's identity, and the lockfile
		// is where that is enforced.
		server: {
			port: app.port,
			strictPort: true,
			fs: { allow: [searchForWorkspaceRoot(process.cwd())] },
		},
	};
}

/** Every app's capabilities, opened once for the page's life (ADR-0766). */
const APP_MODULE = '/src/lib/app.ts';

/**
 * Editing what an app is made of reloads the page (ADR-0768): a change that
 * reaches `src/lib/app.ts`, the file itself or anything it imports, is a new
 * world for the page, and a reload frees the old one whole (its folder, its
 * Worker, every listener) with nothing for the app to close. An edit that
 * reaches only components still updates in place.
 */
function reloadWhenAppChanges(): Plugin {
	return {
		name: 'epicenter:reload-when-app-changes',
		apply: 'serve',
		hotUpdate({ modules }) {
			if (this.environment.name !== 'client') return;
			const seen = new Set<EnvironmentModuleNode>();
			const reachesApp = (node: EnvironmentModuleNode): boolean => {
				if (seen.has(node)) return false;
				seen.add(node);
				if (node.file?.endsWith(APP_MODULE)) return true;
				return [...node.importers].some(reachesApp);
			};
			if (!modules.some(reachesApp)) return;
			this.environment.hot.send({ type: 'full-reload' });
			return [];
		},
	};
}

/**
 * A desktop variant's resolution (`epicenter-standalone`'s README): when
 * `EPICENTER_DESKTOP=1` (an app's `build:native`), the `tauri` condition
 * picks each `#platform/*` seam's desktop leaf from the app's `package.json`
 * "imports"; otherwise nothing changes and every seam is the browser's.
 * Custom conditions replace Vite's defaults, so the defaults are spread
 * after `tauri`. Merge it into the app's config:
 *
 * ```ts
 * mergeConfig(workspaceAppViteConfig(APPS.CAPTURE), desktopVariant(), { … })
 * ```
 */
export function desktopVariant(
	desktop = process.env.EPICENTER_DESKTOP === '1',
): UserConfig {
	if (!desktop) return {};
	return {
		resolve: { conditions: ['tauri', ...defaultClientConditions] },
		ssr: { resolve: { conditions: ['tauri', ...defaultServerConditions] } },
	};
}
