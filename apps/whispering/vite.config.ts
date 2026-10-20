import { APPS } from '@epicenter/constants/apps';
import { hostAppViteConfig } from '@epicenter/vite-config';
import { defineConfig, mergeConfig } from 'vite';
import devtoolsJson from 'vite-plugin-devtools-json';

export default defineConfig(
	mergeConfig(hostAppViteConfig(APPS.WHISPERING), {
		plugins: [devtoolsJson()],
		server: { host: '127.0.0.1' },
	}),
);
