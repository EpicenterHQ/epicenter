import { workspaceAppViteConfig } from '@epicenter/vite-config';
import { defineConfig, mergeConfig } from 'vite';
import devtoolsJson from 'vite-plugin-devtools-json';

/** Whispering's dev port, which `src-tauri/tauri.dev.conf.json` loads. */
const PORT = 1420;

export default defineConfig(
	mergeConfig(workspaceAppViteConfig({ port: PORT }), {
		plugins: [devtoolsJson()],
		server: { host: 'localhost' },
		preview: { port: PORT, strictPort: true, host: 'localhost' },
	}),
);
