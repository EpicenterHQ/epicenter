import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

const __dirname = dirname(fileURLToPath(import.meta.url));
// WXT auto-imports `storage` into workspace-package source but resolves its
// compatibility subpath from that package. Pin it to the extension's actual
// storage entry so shared auth modules with local `storage` bindings still build.
const wxtStorageEntry = fileURLToPath(import.meta.resolve('@wxt-dev/storage'));

export default defineConfig({
	srcDir: 'src',
	modules: ['@wxt-dev/module-svelte'],
	manifest: {
		name: 'Tab Manager',
		description: 'Manage browser tabs with Epicenter',
		// Pins the extension ID to mkbnicfhpacdofmoocppnjjmdfmkkgda across all machines.
		// Required for stable OAuth redirect URL with chrome.identity.
		key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvc/CNEshfeHanSOPQlaQNi/k6Vu81LsrDyxqJEHWPzXa/a4Nk6EeQmSvWAl7YAhW0KGSJoMSGgT0QXh7A0ILCgXtIby4TfVdzlvRkLvhI6eU8iRLUgghvR4Uq9lFLt67uXMFoOQ3hRPxwVNSJqPL9BJv3iWArnaTx54Nl23uot7Xpnt+cDy8qzd8DVW751qKmVbcRgf8oKH67UdcfB1aPyQ64xs+R+P3qXAUdjwEAHDIaAJtEHFyqxIJLutpm9/ahXCyYydayK3atLWKo21M1AbkgClloDGT2CaBawaCG+YksAWrfkaO2WT/lTo0UI8HHcirXuEJuXR4DmyV7vBufwIDAQAB',
		permissions: ['tabs', 'storage', 'identity'],
		// host_permissions needed for favicons and tab info
		host_permissions: ['<all_urls>'],
	},
	vite: () => ({
		plugins: [tailwindcss()],
		resolve: {
			dedupe: ['yjs'],
			alias: {
				'wxt/utils/storage': wxtStorageEntry,
				$lib: resolve(__dirname, 'src/lib'),
			},
		},
	}),
});
