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
import { defaultClientConditions, defineConfig, mergeConfig } from 'vite';
import devtoolsJson from 'vite-plugin-devtools-json';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const isEpicenterHost = process.env.EPICENTER_HOST === '1';

export default defineConfig(
	mergeConfig(workspaceAppViteConfig(APPS.WHISPERING), {
		plugins: [
			devtoolsJson(),
			viteStaticCopy({
				// `stripBase` drops the source's directory segments so each file
				// lands directly at /vad/<name> (the plugin otherwise mirrors the
				// full absolute source path under dest).
				targets: [
					{
						src: new URL(
							'../../packages/client/src/blob-worker.js',
							import.meta.url,
						).pathname,
						dest: '.',
						rename: { stripBase: true, name: 'epicenter-blob-worker.js' },
					},
					...vadAssetSources.map((src) => ({
						src,
						dest: VAD_ASSET_DEST,
						rename: { stripBase: true as const },
					})),
				],
			}),
		],
		// onnxruntime-web (pulled in by @ricky0123/vad-web) ships a WASM glue
		// .mjs that Vite's dep optimizer can't pre-bundle (it 404s on
		// .vite/deps/ort-wasm-simd-threaded.mjs). Keep that package and its wasm
		// subpath native, but still prebundle vad-web so Vite converts its
		// CommonJS entry to ESM for browser dev mode. `mergeConfig` concatenates
		// this with whatever the base config excludes.
		optimizeDeps: { exclude: ['onnxruntime-web', 'onnxruntime-web/wasm'] },
		resolve: {
			// Host builds select brokered auth and native capabilities. Browser
			// builds select the default leaves. Both own their own data store.
			// Preserve Vite's defaults when adding the host condition.
			...(isEpicenterHost && {
				conditions: ['epicenter-host', ...defaultClientConditions],
			}),
		},
	}),
);
