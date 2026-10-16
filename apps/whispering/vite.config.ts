import { APPS } from '@epicenter/constants/apps';
import { installedAppViteConfig } from '@epicenter/vite-config';
import { isInstalledAppBuild } from '@epicenter/vite-config/installed-app';
import { defineConfig, mergeConfig } from 'vite';
import devtoolsJson from 'vite-plugin-devtools-json';

export default defineConfig(
	mergeConfig(installedAppViteConfig(APPS.WHISPERING), {
		plugins: [devtoolsJson()],
		resolve: {
			alias: [
				// As `@epicenter/folder` is: the installed build records through
				// the shell's recorder plugin and carries no WebView microphone
				// code (ADR-0571); the browser build carries no shell recorder.
				{
					find: /^@epicenter\/recorder$/,
					replacement: isInstalledAppBuild()
						? '@epicenter/recorder/tauri'
						: '@epicenter/recorder/browser',
				},
			],
		},
		server: { host: '127.0.0.1' },
	}),
);
