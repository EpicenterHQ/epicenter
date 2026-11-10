import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bareApp, fixture } from './runner.test-support.ts';

setDefaultTimeout(30_000);
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

async function setup() {
	const f = await fixture();
	roots.push(f.root);
	return f;
}

test('init writes EPICENTER.md and starter guidance, keeps existing guidance, and refuses nesting', async () => {
	const f = await setup();
	const folder = join(f.root, 'other');
	await mkdir(folder);
	await writeFile(join(folder, 'AGENTS.md'), 'Keep this guidance.\n');
	const result = await f.run('init', folder, '--port', '4748', '--json');
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({ folder, port: 4748 });
	expect(await readFile(join(folder, 'EPICENTER.md'), 'utf8')).toBe(
		'---\nport: 4748\n---\nThis folder is an Epicenter. Each folder in it with an `epicenter.ts` is an\napp. Run `epicenter` here to list them.\n',
	);
	expect(await readFile(join(folder, 'AGENTS.md'), 'utf8')).toBe(
		'Keep this guidance.\n',
	);
	expect((await f.run('init', folder, '--json')).code).toBe(2);
	expect((await f.run('init', join(folder, 'nested'), '--json')).code).toBe(2);
	expect((await f.runIn(folder, 'init', 'nested', '--json')).code).toBe(2);
	const alias = join(f.root, 'alias');
	await symlink(folder, alias);
	expect((await f.run('init', join(alias, 'nested'), '--json')).code).toBe(2);

	const fresh = join(f.root, 'fresh');
	const defaulted = await f.runIn(f.root, 'init', fresh, '--json');
	expect(defaulted.code).toBe(0);
	expect(JSON.parse(defaulted.stdout).port).toBe(4747);
	expect(await readFile(join(fresh, 'EPICENTER.md'), 'utf8')).toStartWith(
		'---\nport: 4747\n---\n',
	);
	const starter = await readFile(join(fresh, 'AGENTS.md'), 'utf8');
	expect(starter).toContain('epicenter sync <app> -m "<what you did>"');
	expect(starter).toContain(
		'epicenter refuses to snapshot one that is not ignored',
	);
	expect(starter).toContain('Each child folder with an epicenter.ts is an app');
	const shown = await f.run('init', join(f.root, 'shown'));
	expect(shown.stdout).toContain(`Made Epicenter at ${join(f.root, 'shown')}`);
	expect(shown.stderr).toBe('Run: epicenter new <name>\n');
	// A folder that already holds an app is pointed at its listing instead.
	const holding = join(f.root, 'holding');
	await f.folder(join(holding, 'journal'), {
		'epicenter.ts': bareApp('journal'),
	});
	expect((await f.run('init', holding)).stderr).toBe('Run: epicenter\n');
	const current = join(f.root, 'current');
	await mkdir(current);
	expect(
		JSON.parse((await f.runIn(current, 'init', '--json')).stdout).folder,
	).toBe(current);
});

test('walk-up wins over EPICENTER_ROOT, which wins over the default', async () => {
	const f = await setup();
	await f.folder(join(f.home, 'reading'), {
		'epicenter.ts': bareApp('reading'),
	});
	const other = join(f.root, 'other');
	expect((await f.run('init', other, '--json')).code).toBe(0);
	await f.folder(join(other, 'tasks'), {
		'epicenter.ts': bareApp('tasks'),
	});
	f.env.EPICENTER_ROOT = other;
	const fromOutside = JSON.parse((await f.run('--json')).stdout);
	expect(fromOutside.epicenter).toBe(other);
	expect((await f.run()).stdout).toContain(`Epicenter: other (${other})`);
	expect(fromOutside.apps.map((app: { name: string }) => app.name)).toEqual([
		'tasks',
	]);
	expect((await f.run('new', 'from-env')).code).toBe(0);
	expect(await Bun.file(join(other, 'from-env', 'epicenter.ts')).exists()).toBe(
		true,
	);
	const fromInside = JSON.parse(
		(await f.runIn(join(f.home, 'reading'), '--json')).stdout,
	);
	expect(fromInside.epicenter).toBe(f.home);
	expect(fromInside.apps.map((app: { name: string }) => app.name)).toEqual([
		'reading',
	]);
	expect((await f.runIn(f.home, 'new', 'from-cwd')).code).toBe(0);
	expect(
		await Bun.file(join(f.home, 'from-cwd', 'epicenter.ts')).exists(),
	).toBe(true);
	f.env.EPICENTER_ROOT = join(f.root, 'uninitialized');
	const missing = await f.run('--json');
	expect(missing.code).toBe(2);
	expect(JSON.parse(missing.stdout).error.next).toBe(
		`epicenter init ${f.env.EPICENTER_ROOT}`,
	);
	expect(
		JSON.parse((await f.run('invalid_name', '--json')).stdout).error.next,
	).toBe(`epicenter init ${f.env.EPICENTER_ROOT}`);
});

test('the marker is found from inside an app, and its front matter is checked field by field', async () => {
	const f = await setup();
	const inside = await f.folder(join(f.home, 'reading'), {
		'epicenter.ts': bareApp('reading'),
		'notes/today.md': 'x',
	});
	const marker = join(f.home, 'EPICENTER.md');
	const listed = async () => f.runIn(join(inside, 'notes'), '--json');
	await writeFile(
		marker,
		'---\nport: 4800\n---\nNotes for people.\n',
	);
	expect(JSON.parse((await listed()).stdout).epicenter).toBe(f.home);
	await writeFile(marker, '---\nport: 70000\nprot: 4748\n---\n');
	const refused = await listed();
	expect(refused.code).toBe(2);
	expect(JSON.parse(refused.stdout).error.message.split('\n')).toEqual([
		`${marker}: port: 70000 is not a whole number from 0 to 65535`,
		`${marker}: prot is not a field; the fields are port, public, and publicPort`,
	]);
	await writeFile(marker, '---\nport: [unclosed\n---\n');
	expect(JSON.parse((await listed()).stdout).error.message).toBe(
		`${marker}: its front matter is neither key: <JSON> lines nor YAML`,
	);
});

test('the marker takes public and publicPort together, an https origin and a port of its own', async () => {
	const f = await setup();
	const marker = join(f.home, 'EPICENTER.md');
	await writeFile(
		marker,
		'---\nport: 4747\npublic: https://studio.example.com:10000\npublicPort: 10000\n---\n',
	);
	expect((await f.run('--json')).code).toBe(0);
	for (const [contents, problem] of [
		[
			'---\npublic: http://studio.example.com\npublicPort: 10000\n---\n',
			'public: "http://studio.example.com" is not an https origin with no path, such as https://host:10000',
		],
		[
			'---\npublic: https://studio.example.com/epicenter/\npublicPort: 10000\n---\n',
			'public: "https://studio.example.com/epicenter/" is not an https origin with no path, such as https://host:10000',
		],
		[
			'---\npublic: https://studio.example.com/?a=1\npublicPort: 10000\n---\n',
			'public: "https://studio.example.com/?a=1" is not an https origin with no path, such as https://host:10000',
		],
		[
			'---\npublic: https://studio.example.com\n---\n',
			'public and publicPort come together: give both or neither',
		],
		[
			'---\npublicPort: 10000\n---\n',
			'public and publicPort come together: give both or neither',
		],
		[
			'---\npublic: https://studio.example.com\npublicPort: 4747\n---\n',
			'publicPort: 4747 is also the port; the public listener needs a port of its own',
		],
		[
			'---\npublic: https://studio.example.com\npublicPort: 1.5\n---\n',
			'publicPort: 1.5 is not a whole number from 0 to 65535',
		],
	] as const) {
		await writeFile(marker, contents);
		const result = await f.run('--json');
		expect(result.code).toBe(2);
		expect(JSON.parse(result.stdout).error.message).toBe(
			`${marker}: ${problem}`,
		);
	}
});

test('the marker is matched by its exact name, and a byte order mark before its front matter is ignored', async () => {
	const f = await setup();
	// A note above the Epicenter whose name differs from the marker's by case alone.
	await writeFile(join(f.root, 'Epicenter.md'), 'A note about Epicenter.\n');
	const insensitive = existsSync(join(f.root, 'EPICENTER.md'));
	const elsewhere = join(f.root, 'elsewhere');
	await mkdir(elsewhere);
	expect(
		JSON.parse((await f.runIn(elsewhere, '--json')).stdout).epicenter,
	).toBe(f.home);
	expect((await f.run('init', join(f.root, 'beside'), '--json')).code).toBe(0);
	const over = await f.run('init', f.root, '--json');
	if (insensitive) {
		expect(over.code).toBe(2);
		expect(JSON.parse(over.stdout).error.message).toBe(
			`${f.root} holds Epicenter.md, which this disk does not tell apart from EPICENTER.md; rename it, then run init again`,
		);
		expect(await readFile(join(f.root, 'Epicenter.md'), 'utf8')).toBe(
			'A note about Epicenter.\n',
		);
	} else expect(over.code).toBe(0);

	const marker = join(f.home, 'EPICENTER.md');
	await writeFile(marker, '\uFEFF---\nprot: 4748\n---\n');
	expect(JSON.parse((await f.run('--json')).stdout).error.message).toBe(
		`${marker}: prot is not a field; the fields are port, public, and publicPort`,
	);
	await writeFile(marker, '\uFEFF---\nport: 4800\n---\n');
	expect((await f.run('--json')).code).toBe(0);
});

test('build reports each app and keeps the last good UI after failure', async () => {
	const f = await setup();
	await f.folder(join(f.home, 'capture'), {
		'epicenter.ts': bareApp('capture'),
	});
	const tasks = await f.folder(join(f.home, 'tasks'), {
		'epicenter.ts': bareApp('tasks'),
		'ui/package.json': JSON.stringify({
			private: true,
			scripts: { build: 'bun build.ts' },
		}),
		'ui/.gitignore': 'dist/\nnode_modules/\n',
		'ui/build.ts': `await Bun.write('dist/index.html', 'good');\n`,
	});
	const first = await f.run('build', '--json');
	expect(first.code).toBe(0);
	expect(
		JSON.parse(first.stdout).apps.map(
			(app: { app: string; built: boolean }) => [app.app, app.built],
		),
	).toEqual([
		['capture', false],
		['tasks', true],
	]);
	expect(await readFile(join(tasks, 'ui/dist/index.html'), 'utf8')).toBe(
		'good',
	);
	await writeFile(
		join(tasks, 'ui/build.ts'),
		`throw new Error('build broke');\n`,
	);
	const failed = await f.run('build', 'tasks', '--json');
	expect(failed.code).toBe(1);
	expect(JSON.parse(failed.stdout).apps[0].error.message).toContain(
		'build broke',
	);
	expect(await readFile(join(tasks, 'ui/dist/index.html'), 'utf8')).toBe(
		'good',
	);
	expect((await f.run('build', 'capture')).stdout).toBe(
		'capture: nothing to build\n',
	);
	// A view written by hand has no build script, and building leaves it alone.
	const capture = join(f.home, 'capture');
	await mkdir(join(capture, 'ui', 'dist'), { recursive: true });
	await writeFile(
		join(capture, 'ui', 'package.json'),
		JSON.stringify({ name: 'ui', private: true }),
	);
	await writeFile(join(capture, 'ui', 'dist', 'index.html'), 'by hand');
	expect((await f.run('build', 'capture')).stdout).toBe(
		'capture: nothing to build\n',
	);
	expect(
		await readFile(join(capture, 'ui', 'dist', 'index.html'), 'utf8'),
	).toBe('by hand');
});

test("serve reads the marker's port when no command port is given", async () => {
	const f = await setup();
	await writeFile(join(f.home, 'EPICENTER.md'), '---\nport: 0\n---\n');
	const child = Bun.spawn([process.execPath, f.bin, 'serve'], {
		cwd: f.root,
		env: f.env,
		stdout: 'ignore',
		stderr: 'pipe',
	});
	try {
		const reader = child.stderr.getReader();
		const started = (async () => {
			let output = '';
			for (;;) {
				const { value, done } = await reader.read();
				if (done) throw new Error(output || 'serve exited before listening');
				output += new TextDecoder().decode(value);
				if (/Serving your apps at http:\/\/127\.0\.0\.1:\d+\./.test(output))
					return;
			}
		})();
		await Promise.race([
			started,
			Bun.sleep(10_000).then(() => {
				throw new Error('serve did not start');
			}),
		]);
	} finally {
		child.kill('SIGTERM');
		await child.exited;
	}
});
