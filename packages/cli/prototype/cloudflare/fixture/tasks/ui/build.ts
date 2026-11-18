/**
 * Builds the UI with Bun's bundler: `index.html` and the files it loads, into
 * the folder `EPICENTER_OUT` names when `epicenter` builds it (ADR-0880), else
 * `ui/dist/`. Every URL it writes is relative, so the page works at whatever
 * path `epicenter serve` serves it.
 */
import { rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { BunPlugin } from 'bun';
import tailwind from 'bun-plugin-tailwind';
import { svelte } from './svelte-plugin.ts';

const outdir = resolve(
	process.env.EPICENTER_OUT ?? join(import.meta.dir, 'dist'),
);

/**
 * Bun inlines every CSS url() under 128 KB as a data: URL, which would put
 * every font subset into the stylesheet. Keep fonts as files instead.
 */
const fonts = new Set<string>();
const fontFiles: BunPlugin = {
	name: 'font-files',
	setup(build) {
		build.onResolve({ filter: /\.woff2?$/ }, ({ path, importer }) => {
			fonts.add(resolve(importer, '..', path));
			return { path: `./fonts/${basename(path)}`, external: true };
		});
	},
};

await rm(outdir, { recursive: true, force: true });
const result = await Bun.build({
	entrypoints: [join(import.meta.dir, 'index.html')],
	outdir,
	minify: true,
	// The manifest names its icons, so they keep their names.
	naming: { asset: '[name].[ext]' },
	plugins: [svelte, tailwind, fontFiles],
	throw: false,
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
for (const font of fonts)
	await Bun.write(join(outdir, 'fonts', basename(font)), Bun.file(font));
