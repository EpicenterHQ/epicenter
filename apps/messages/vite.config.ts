import { workspaceAppViteConfig } from '@epicenter/vite-config';
import { type Connect, defineConfig, mergeConfig, type Plugin } from 'vite';

/** The port Messages is served on (`MESSAGES_PORT` in `scripts/serve.ts`). */
const PORT = 5188;

/**
 * `bun dev:messages` answers the page's drafts' directory as Messages'
 * program does (`scripts/dev-drafts.ts`), loaded through Vite on the first
 * request for it.
 */
function devDrafts(): Plugin {
	return {
		name: 'messages:dev-drafts',
		apply: 'serve',
		configureServer(server) {
			let answer: Promise<Connect.SimpleHandleFunction> | undefined;
			server.middlewares.use((req, res, next) => {
				if (!req.url?.startsWith('/folder/')) return next();
				answer ??= server
					.ssrLoadModule('/scripts/dev-drafts.ts')
					.then(({ devDrafts }) =>
						devDrafts((stop: () => void) =>
							server.httpServer?.on('close', stop),
						),
					);
				answer.then((handle) => handle(req, res), next);
			});
		},
	};
}

export default defineConfig(
	mergeConfig(workspaceAppViteConfig({ port: PORT }), {
		plugins: [devDrafts()],
	}),
);
