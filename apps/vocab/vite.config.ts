import { APPS } from '@epicenter/constants/apps';
// VAD fetches these files from `/vad/*` at runtime (they are not bundled). The
// recorder package owns the VAD capability and resolves the asset source paths
// from its own pinned dependency tree; we just copy them into the served `/vad/`
// directory at build time (see @epicenter/recorder/vad-assets).
import {
	VAD_ASSET_DEST,
	vadAssetSources,
} from '@epicenter/recorder/vad-assets';
import { workspaceAppViteConfig } from '@epicenter/vite-config';
import {
	defaultClientConditions,
	defaultServerConditions,
	defineConfig,
	mergeConfig,
} from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

/** The desktop program's pages (`build:native`); see `svelte.config.js`. */
const desktop = process.env.EPICENTER_DESKTOP === '1';

export default defineConfig(
	mergeConfig(workspaceAppViteConfig(APPS.VOCAB), {
		// The desktop build resolves each `#platform/*` seam to its `tauri`
		// leaf, in SvelteKit's server pass too. Custom conditions replace
		// Vite's defaults, so the spread of the defaults is load-bearing.
		...(desktop && {
			resolve: { conditions: ['tauri', ...defaultClientConditions] },
			ssr: { resolve: { conditions: ['tauri', ...defaultServerConditions] } },
		}),
		plugins: [
			viteStaticCopy({
				// `stripBase` drops the source's directory segments so each file
				// lands directly at /vad/<name> (the plugin otherwise mirrors the
				// full absolute source path under dest).
				targets: vadAssetSources.map((src) => ({
					src,
					dest: VAD_ASSET_DEST,
					rename: { stripBase: true },
				})),
			}),
		],
		// onnxruntime-web (pulled in by @ricky0123/vad-web) ships a WASM glue
		// .mjs that Vite's dep optimizer can't pre-bundle (it 404s on
		// .vite/deps/ort-wasm-simd-threaded.mjs). Keep that package and its wasm
		// subpath native, but still prebundle vad-web so Vite converts its
		// CommonJS entry to ESM for browser dev mode.
		optimizeDeps: {
			exclude: ['onnxruntime-web', 'onnxruntime-web/wasm'],
		},
		// localhost, not 127.0.0.1: the API registers Vocab's sign-in callback
		// at `http://localhost:8888`.
		server: { host: 'localhost' },
		preview: { port: APPS.VOCAB.port, strictPort: true, host: 'localhost' },
		// The device's OPFS Worker is a module Worker.
		worker: { format: 'es' },
	}),
);
