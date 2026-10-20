import { hostAppViteConfig } from '@epicenter/vite-config';
import { defineConfig, mergeConfig } from 'vite';

export default defineConfig(
	mergeConfig(hostAppViteConfig({ port: 5186 }), {
		server: { host: '127.0.0.1' },
	}),
);
