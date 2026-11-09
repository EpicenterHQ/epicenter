import { APPS } from '@epicenter/definition/site';
import { workspaceAppViteConfig } from '@epicenter/vite-config';
import { defineConfig, mergeConfig } from 'vite';
import devtoolsJson from 'vite-plugin-devtools-json';

export default defineConfig(
	mergeConfig(workspaceAppViteConfig(APPS.WHISPERING), {
		plugins: [devtoolsJson()],
		// localhost, not 127.0.0.1: the API registers Whispering's sign-in
		// callback at `http://localhost:1420`.
		server: { host: 'localhost' },
		preview: {
			port: APPS.WHISPERING.port,
			strictPort: true,
			host: 'localhost',
		},
	}),
);
