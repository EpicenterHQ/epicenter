import { APPS } from '@epicenter/constants/apps';
import { workspaceAppViteConfig } from '@epicenter/vite-config';
import { defaultClientConditions, defineConfig, mergeConfig } from 'vite';

export default defineConfig(
	mergeConfig(workspaceAppViteConfig(APPS.CAPTURE), {
		resolve: {
			...(process.env.EPICENTER_HOST === '1' && {
				conditions: ['epicenter-host', ...defaultClientConditions],
			}),
		},
	}),
);
