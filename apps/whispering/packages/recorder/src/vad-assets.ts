import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Build-time helper for serving the VAD runtime assets. This module is meant for
 * an app's Vite config (Node), not browser code.
 *
 * `@ricky0123/vad-web` fetches its worklet, Silero ONNX model, and onnxruntime
 * wasm from a base path at runtime (default `/vad/`, see `createVadRecorder`'s
 * `assetBaseUrl`); the files are not bundled. Each consuming app must copy them
 * out of the installed packages so they are served at that path. This resolves
 * the source paths from this package's own dependency tree so every consumer
 * copies the exact files the lockfile pins.
 *
 * onnxruntime-web is a transitive dependency of @ricky0123/vad-web, not declared
 * here, so it is unreachable directly under an isolated (pnpm-style)
 * node_modules. Resolve it relative to vad-web's own entry instead, which works
 * under both hoisted and isolated installs. Resolve each package's entry, not a
 * package.json subpath, which onnxruntime-web blocks via `exports`.
 */
const vadEntry = createRequire(import.meta.url).resolve('@ricky0123/vad-web');
const vadDist = dirname(vadEntry);
const ortDist = dirname(createRequire(vadEntry).resolve('onnxruntime-web'));

/**
 * Absolute source paths of the VAD assets to copy into the served `/vad/`
 * directory. Backslashes are normalized to forward slashes because
 * `vite-plugin-static-copy` treats `src` as a glob.
 */
export const vadAssetSources: string[] = [
	join(vadDist, 'vad.worklet.bundle.min.js'),
	join(vadDist, 'silero_vad_v5.onnx'),
	join(ortDist, 'ort-wasm-simd-threaded.mjs'),
	join(ortDist, 'ort-wasm-simd-threaded.wasm'),
].map((path) => path.replace(/\\/g, '/'));

/**
 * Directory name (relative to the app's served root) the assets must land in so
 * they match the default `assetBaseUrl` of `/vad/`.
 */
export const VAD_ASSET_DEST = 'vad';
