// Throwaway proof: this compiler executes inside workerd, never in the upload CLI.

import { posix as path } from 'node:path';
import { createWorker } from '@cloudflare/worker-bundler';
import {
	resolve as packageExport,
	imports as packageImport,
} from 'resolve.exports';
import { transform } from 'sucrase';
import { compile, compileModule } from 'svelte/compiler';
import { compile as compileCss } from 'tailwindcss';

export type Source = {
	read(path: string): string | null;
	has(path: string): boolean;
	load(path: string): string | null | Promise<string | null>;
	list(prefix?: string): string[];
};
export function resolver(fs: Source, client: boolean) {
	const conditions = client
		? ['svelte', 'browser', 'import', 'default']
		: ['workerd', 'worker', 'browser', 'import', 'default'];
	const readJson = (at: string) =>
		JSON.parse(fs.read(`${at}/package.json`) ?? '{}');
	function file(at: string): string {
		at = path.normalize(at).replace(/^\//, '');
		const variants = [
			at,
			...(at.endsWith('.js') ? [at.slice(0, -3) + '.ts'] : []),
			...[
				'.ts',
				'.js',
				'.mjs',
				'.svelte',
				'.json',
				'.css',
				'/index.ts',
				'/index.js',
			].map((ext) => at + ext),
		];
		const found = variants.find((candidate) => fs.has(candidate));
		if (found) return found;
		if (fs.read(`${at}/package.json`))
			return file(
				`${at}/${readJson(at).module ?? readJson(at).main ?? 'index.js'}`,
			);
		throw new Error(`Cannot resolve ${at}`);
	}
	function nearestPackage(importer: string) {
		let dir = path.dirname(importer);
		while (dir !== '.') {
			if (fs.read(`${dir}/package.json`)) return dir;
			dir = path.dirname(dir);
		}
		return '';
	}
	function resolve(specifier: string, importer = '', css = false): string {
		if (specifier === '@epicenter/app') return 'runtime/src/index.ts';
		if (specifier === '@epicenter/app/client') return 'runtime/src/client.ts';
		if (specifier.startsWith('$lib/'))
			return file(`ui/src/lib/${specifier.slice(5)}`);
		if (specifier.startsWith('.') || specifier.startsWith('/'))
			return file(path.join(path.dirname(importer), specifier));
		if (specifier.startsWith('#')) {
			const root = nearestPackage(importer);
			const pkg = readJson(root);
			const target = packageImport(pkg, specifier, {
				conditions,
				unsafe: true,
			})?.[0];
			if (!target) throw new Error(`Missing import ${specifier} in ${root}`);
			return target.startsWith('.')
				? file(path.join(root, target))
				: resolve(target, `${root}/package.json`, css);
		}
		const parts = specifier.split('/');
		const name = specifier.startsWith('@')
			? parts.slice(0, 2).join('/')
			: parts[0];
		const suffix = specifier.slice(name.length);
		let dir = path.dirname(importer);
		for (;;) {
			const root = path.join(dir === '.' ? '' : dir, 'node_modules', name);
			if (fs.read(`${root}/package.json`)) {
				const pkg = readJson(root);
				let target: string | undefined;
				if (pkg.exports)
					target = packageExport(pkg, suffix ? '.' + suffix : '.', {
						conditions: css ? ['style', ...conditions] : conditions,
						unsafe: true,
					})?.[0];
				else
					target = suffix
						? '.' + suffix
						: css && pkg.style
							? pkg.style
							: (pkg.module ?? pkg.main ?? 'index.js');
				if (!target) throw new Error(`No export ${specifier} in ${root}`);
				return file(path.join(root, target));
			}
			if (dir === '.' || !dir) break;
			dir = path.dirname(dir);
		}
		throw new Error(`Package not uploaded: ${specifier} from ${importer}`);
	}
	return { file, resolve };
}

export async function build(fs: Source) {
	const output: Record<string, string> = {};
	let components = 0;
	async function bundle(entryPoint: string, client: boolean) {
		const r = resolver(fs, client);
		const plugin = {
			name: 'prototype-svelte-files',
			setup(api: any) {
				api.onResolve({ filter: /.*/ }, (args: any) => {
					if (/^(node:|cloudflare:)/.test(args.path))
						return { path: args.path, external: true };
					const resolved =
						args.kind === 'entry-point'
							? r.file(args.path)
							: r.resolve(args.path, args.importer);
					return { path: resolved, namespace: 'prototype' };
				});
				api.onLoad(
					{ filter: /.*/, namespace: 'prototype' },
					async (args: any) => {
						let source = await fs.load(args.path);
						if (source === null) throw new Error(`Missing source ${args.path}`);
						let loader = 'js';
						if (args.path.endsWith('.svelte')) {
							components++;
							source = compile(source, {
								filename: args.path,
								generate: 'client',
								css: 'injected',
								experimental: { async: true },
							}).js.code;
							loader = 'ts';
						} else if (/\.svelte\.[jt]s$/.test(args.path)) {
							source = compileModule(
								args.path.endsWith('.ts')
									? transform(source, { transforms: ['typescript'] }).code
									: source,
								{
									filename: args.path,
									generate: 'client',
									experimental: { async: true },
								},
							).js.code;
						} else if (args.path.endsWith('.ts')) loader = 'ts';
						else if (args.path.endsWith('.json')) loader = 'json';
						return {
							contents: source,
							loader,
							resolveDir: path.dirname(args.path),
						};
					},
				);
			},
		};
		const bundled = await createWorker({
			files: {
				read: fs.read.bind(fs),
				write() {},
				delete() {},
				list: fs.list.bind(fs),
				async flush() {},
			},
			entryPoint,
			minify: client,
			conditions: client
				? ['svelte', 'browser']
				: ['workerd', 'worker', 'node'],
			define: { 'process.env.NODE_ENV': '"production"' },
			__dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired: [plugin],
		});
		return bundled;
	}
	const server = await bundle('server.ts', false);
	const client = await bundle('ui/src/main.ts', true);
	const module = client.modules[client.mainModule];
	output['/main.js'] = typeof module === 'string' ? module : module.js!;
	const cssResolver = resolver(fs, true);
	const css = await compileCss(fs.read('ui/src/app.css')!, {
		base: 'ui/src',
		loadStylesheet: async (id, base) => {
			const found = cssResolver.resolve(id, `${base}/__style.css`, true);
			let content = fs.read(found)!;
			if (found.includes('@fontsource-variable/'))
				content = content.replace(
					/url\((['"]?)\.\/files\/([^)'"\s]+)\1\)/g,
					'url("./fonts/$2")',
				);
			return { content, base: path.dirname(found), path: found };
		},
	});
	const tokens = new Set<string>();
	for (const name of fs.list('ui/'))
		if (/\.(svelte|ts|html)$/.test(name))
			for (const token of (fs.read(name) ?? '').match(/[^\s"'`<>]+/g) ?? [])
				tokens.add(token);
	output['/app.css'] = css.build([...tokens]);
	output['/index.html'] = fs
		.read('ui/index.html')!
		.replace('./src/app.css', './app.css')
		.replace('./src/main.ts', './main.js');
	return {
		server,
		assets: output,
		components,
		compiler: 'svelte/compiler + esbuild-wasm + tailwindcss inside workerd',
	};
}
