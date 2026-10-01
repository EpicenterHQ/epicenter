import { workspaceAppViteConfig } from '@epicenter/vite-config';
import {
	defaultClientConditions,
	defineConfig,
	mergeConfig,
	type Plugin,
} from 'vite';

// Two builds from one source. Under `EPICENTER_HOST=1` the SPA is served by
// Epicenter below `/apps/mail/` and reaches the host's SQLite files and
// credential store; otherwise it is a standalone static build over OPFS and a
// credential that lives as long as the tab (ADR-0310).
const isEpicenterHost = process.env.EPICENTER_HOST === '1';

// Not in `APPS`: that table maps an app to its production origin, and Local
// Mail is a desktop application with no hosted one. The port is a dev fact and
// lives where it is used.
const SPA_DEV_PORT = 5177;

/**
 * Deny framing on every dev response so a cross-origin page cannot frame the
 * dev SPA and clickjack a triage write. A `configureServer` middleware, because
 * SvelteKit's dev page responses bypass Vite's `server.headers`.
 */
function denyFramingInDev(): Plugin {
	return {
		name: 'local-mail-deny-framing',
		apply: 'serve',
		configureServer(server) {
			server.middlewares.use((_req, res, next) => {
				res.setHeader('X-Frame-Options', 'DENY');
				res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
				next();
			});
		},
	};
}

export default defineConfig(
	mergeConfig(workspaceAppViteConfig({ port: SPA_DEV_PORT }), {
		plugins: [denyFramingInDev()],
		resolve: {
			// Build-time platform DI for auth and App resources. The spread is
			// load-bearing: custom conditions REPLACE Vite's defaults, so a seam
			// mistake fails at build time rather than at a person's runtime.
			...(isEpicenterHost && {
				conditions: ['epicenter-host', ...defaultClientConditions],
			}),
		},
	}),
);
