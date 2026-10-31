import { desktopAppViteConfig } from '@epicenter/vite-config';
import { defineConfig, mergeConfig } from 'vite';

export default defineConfig(
	mergeConfig(desktopAppViteConfig({ port: 5186 }), {
		server: { host: '127.0.0.1' },
	}),
);
