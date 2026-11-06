import { desktopVariant, workspaceAppViteConfig } from '@epicenter/vite-config';
import { defineConfig, mergeConfig } from 'vite';
export default defineConfig(
	mergeConfig(workspaceAppViteConfig({ port: 5188 }), desktopVariant()),
);
