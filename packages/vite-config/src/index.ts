import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import {
	defaultClientConditions,
	searchForWorkspaceRoot,
	type UserConfig,
} from 'vite';

type WorkspaceAppViteConfigOptions = {
	tauri?: boolean;
};

/**
 * Base Vite config for SvelteKit workspace apps whose package contract and
 * browser composition live at the app root, outside `src/`.
 *
 * The `@y/y` dedupe is load-bearing for CRDT identity.
 *
 * The `fs.allow` entry is load-bearing too, but not because of Vite's own
 * default. @sveltejs/kit's plugin sets fs.allow to the app `src/`, the app and
 * workspace-root `node_modules`, and its own output, and nothing else. That
 * omits the monorepo root, so the app-root composition files (the package
 * contract and browser entry that live outside `src/`) and sibling-package
 * source are unreadable in dev. Adding the workspace root restores both; Vite
 * concatenates it with SvelteKit's entries rather than replacing them.
 */
export function workspaceAppViteConfig(
	app: { port: number },
	options: WorkspaceAppViteConfigOptions = {},
): UserConfig {
	const isTauri = options.tauri && process.env.TAURI_ENV_PLATFORM !== undefined;

	return {
		// Bun can split `vite` into peer-variant installs (`vite@7.3.5+<hashA>`
		// vs `+<hashB>`), which makes identical `Plugin` types compare unequal
		// across app configs. Keep the cast here, the one place every workspace
		// app's plugins come from, instead of leaking the workaround into each app.
		plugins: [sveltekit(), tailwindcss()] as UserConfig['plugins'],
		resolve: {
			// Custom conditions replace Vite's defaults, so keep the default
			// client conditions when a Tauri build opts into platform DI.
			...(isTauri && { conditions: ['tauri', ...defaultClientConditions] }),
			dedupe: ['@y/y'],
		},
		server: {
			port: app.port,
			strictPort: true,
			fs: { allow: [searchForWorkspaceRoot(process.cwd())] },
		},
	};
}
