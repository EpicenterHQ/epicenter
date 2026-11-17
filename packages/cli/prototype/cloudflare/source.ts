// Uploads raw source and dependency files. Does not invoke a compiler or bundler.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
const root = import.meta.dir;
export async function sources() {
	const files: Record<string, string> = {};
	const binaries: Record<string, string> = {};
	async function tree(actual: string, virtual: string) {
		for (const item of await readdir(actual, { withFileTypes: true })) {
			if (
				['node_modules', '.git', 'data', '.check'].includes(item.name) ||
				(item.name === 'dist' && !virtual.startsWith('node_modules/'))
			)
				continue;
			const file = join(actual, item.name),
				target = `${virtual}/${item.name}`.replace(/^\//, '');
			if (item.isDirectory()) await tree(file, target);
			else if (
				/\.(js|mjs|cjs|json|css|svelte|ts|html|webmanifest|svg)$/.test(
					item.name,
				) &&
				!/(\.d\.ts|\.test\.ts|\.map)$/.test(item.name)
			) {
				try {
					files[target] = await readFile(file, 'utf8');
				} catch (error) {
					if (!target.endsWith('/theme.css')) throw error;
				}
			} else if (/\.(woff2|png)$/.test(item.name)) {
				binaries[
					target.includes('/files/') ? `/fonts/${item.name}` : `/${target}`
				] = Buffer.from(await readFile(file)).toString('base64');
			}
		}
	}
	await tree(join(root, 'fixture/tasks/ui'), 'ui');
	files['epicenter.ts'] = await readFile(
		join(root, 'fixture/tasks/epicenter.ts'),
		'utf8',
	);
	files['review.prototype.ts'] = await readFile(
		join(root, 'fixture/tasks/review.prototype.ts'),
		'utf8',
	);
	await tree(join(root, 'fixture/app-runtime/src'), 'runtime/src');
	files['ui/src/theme.css'] = await readFile(
		join(root, 'fixture/tasks/ui/src/theme.css'),
		'utf8',
	);
	const task = JSON.parse(
		await readFile(join(root, 'fixture/tasks/package.json'), 'utf8'),
	);
	const seen = new Set<string>();
	async function packageAt(name: string, from = root) {
		let dir = from,
			actual: string | undefined;
		for (;;) {
			const candidate = join(dir, 'node_modules', name);
			if (await Bun.file(join(candidate, 'package.json')).exists()) {
				actual = candidate;
				break;
			}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
		if (!actual) throw new Error(`Dependency unavailable: ${name}`);
		const virtual = relative(root, actual);
		if (virtual.startsWith('..'))
			throw new Error(`Dependency outside prototype: ${name}`);
		if (seen.has(actual)) return;
		seen.add(actual);
		await tree(actual, virtual);
		const manifest = JSON.parse(
			await readFile(join(actual, 'package.json'), 'utf8'),
		);
		for (const dependency of Object.keys(manifest.dependencies ?? {}))
			await packageAt(dependency, actual);
	}
	for (const name of new Set([
		...Object.keys(task.dependencies),
		'yaml',
		'nanoid',
		'typebox',
		'wellcrafted',
	]))
		await packageAt(name);
	// Assets referenced by index.html have public /static paths, not /ui/static paths.
	for (const [at, body] of Object.entries(files))
		if (at.startsWith('ui/static/'))
			binaries['/' + at.slice(3)] = Buffer.from(body).toString('base64');
	for (const [at, body] of Object.entries(binaries))
		if (at.startsWith('/ui/static/')) {
			binaries[at.slice(3)] = body;
			delete binaries[at];
		}
	return { files, binaries, packages: seen.size };
}
export async function api(origin: string, route: string, body?: unknown) {
	const token = Bun.env.TASKS_PROTOTYPE_TOKEN;
	if (!token) throw new Error('Set TASKS_PROTOTYPE_TOKEN');
	const response = await fetch(new URL(origin.replace(/\/$/, '') + route), {
		method: body === undefined ? 'GET' : 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const raw = await response.text();
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		value = raw;
	}
	return { response, value, raw };
}
export async function seed(origin: string) {
	const payload = await sources();
	const entries = Object.entries(payload.files);
	for (let i = 0; i < entries.length; i += 80) {
		const { response, raw } = await api(origin, '/admin/source', {
			files: Object.fromEntries(entries.slice(i, i + 80)),
		});
		if (!response.ok) throw new Error(`Upload ${i}: ${raw}`);
	}
	const entriesBinary = Object.entries(payload.binaries);
	for (let i = 0; i < entriesBinary.length; i += 10) {
		const { response, raw } = await api(origin, '/admin/static', {
			files: Object.fromEntries(entriesBinary.slice(i, i + 10)),
		});
		if (!response.ok) throw new Error(`Asset upload: ${raw}`);
	}
	console.log(
		JSON.stringify({
			uploadedSourceFiles: entries.length,
			packages: payload.packages,
			binaryAssets: entriesBinary.length,
			sourceBytes: entries.reduce(
				(n, [, text]) => n + Buffer.byteLength(text),
				0,
			),
			localCompilation: false,
		}),
	);
	return payload;
}
if (import.meta.main) await seed(process.argv[2] ?? 'http://localhost:8799');
