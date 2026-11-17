import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from './git.js';
import { bareApp, fixture, freePort, gitIn } from './runner.test-support.ts';

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
	await writeFile(join(folder, 'theme.css'), '/* personal palette */');
	const result = await f.run('init', folder, '--port', '4748', '--json');
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({ folder, port: 4748 });
	expect(await readFile(join(folder, 'EPICENTER.md'), 'utf8')).toBe(
		'---\nport: 4748\n---\nThis folder is an Epicenter. Each folder in its `apps/` is an app: its code in `code/`, its records in `data/`. Run `epicenter` here to list them.\n',
	);
	expect(await readFile(join(folder, 'AGENTS.md'), 'utf8')).toBe(
		'Keep this guidance.\n',
	);
	expect((await f.run('init', folder, '--json')).code).toBe(2);
	expect(await readFile(join(folder, 'theme.css'), 'utf8')).toBe(
		'/* personal palette */',
	);
	expect(await gitIn(folder, 'ls-files', '--', 'theme.css')).toBe('');
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
	const seeded = await readFile(join(fresh, 'theme.css'), 'utf8');
	expect(seeded).toContain('--primary:');
	expect(seeded).toContain('.dark {');
	expect(await gitIn(fresh, 'show', 'HEAD:theme.css')).toBe(seeded.trimEnd());
	const starter = await readFile(join(fresh, 'AGENTS.md'), 'utf8');
	expect(starter).toContain('one private Git repository');
	expect(starter).toContain('Actions make no commits.');
	expect(starter).toContain('checkpoint');
	const shown = await f.run('init', join(f.root, 'shown'));
	expect(shown.stdout).toContain(`Made Epicenter at ${join(f.root, 'shown')}`);
	expect(shown.stderr).toBe(
		'Run: epicenter new writing --from EpicenterHQ/epicenter/examples/writing\n',
	);
	// A folder that already holds an app is pointed at its listing instead.
	const holding = join(f.root, 'holding');
	await f.folder(join(holding, 'apps', 'journal'), {
		'code/epicenter.ts': bareApp('journal'),
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
	await f.folder(join(f.apps, 'reading'), {
		'code/epicenter.ts': bareApp('reading'),
	});
	const other = join(f.root, 'other');
	expect((await f.run('init', other, '--json')).code).toBe(0);
	await f.folder(join(other, 'apps', 'tasks'), {
		'code/epicenter.ts': bareApp('tasks'),
	});
	f.env.EPICENTER_ROOT = other;
	const fromOutside = JSON.parse((await f.run('--json')).stdout);
	expect(fromOutside.epicenter).toBe(other);
	expect((await f.run()).stdout).toContain(`Epicenter: other (${other})`);
	expect(fromOutside.apps.map((app: { name: string }) => app.name)).toEqual([
		'tasks',
	]);
	expect((await f.run('new', 'from-env')).code).toBe(0);
	expect(
		await Bun.file(
			join(other, 'apps', 'from-env', 'code/epicenter.ts'),
		).exists(),
	).toBe(true);
	const fromInside = JSON.parse(
		(await f.runIn(join(f.apps, 'reading'), '--json')).stdout,
	);
	expect(fromInside.epicenter).toBe(f.home);
	expect(fromInside.apps.map((app: { name: string }) => app.name)).toEqual([
		'reading',
	]);
	expect((await f.runIn(f.home, 'new', 'from-cwd')).code).toBe(0);
	expect(
		await Bun.file(join(f.apps, 'from-cwd', 'code/epicenter.ts')).exists(),
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
	const inside = await f.folder(join(f.apps, 'reading'), {
		'code/epicenter.ts': bareApp('reading'),
		'notes/today.md': 'x',
	});
	const marker = join(f.home, 'EPICENTER.md');
	const listed = async () => f.runIn(join(inside, 'notes'), '--json');
	await writeFile(marker, '---\nport: 4800\n---\nNotes for people.\n');
	expect(JSON.parse((await listed()).stdout).epicenter).toBe(f.home);
	await writeFile(marker, '---\nport: 70000\nprot: 4748\n---\n');
	const refused = await listed();
	expect(refused.code).toBe(2);
	expect(JSON.parse(refused.stdout).error.message.split('\n')).toEqual([
		`${marker}: port: 70000 is not a whole number from 1 to 65535`,
		`${marker}: prot is not a field; the only field is port`,
	]);
	await writeFile(marker, '---\nport: [unclosed\n---\n');
	expect(JSON.parse((await listed()).stdout).error.message).toBe(
		`${marker}: port on line 2 is not JSON`,
	);
	await writeFile(marker, '---\n# the port\nport: 4800\n---\n');
	expect(JSON.parse((await listed()).stdout).error.message).toBe(
		`${marker}: its front matter is not key: value lines between two --- lines, each key once`,
	);
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

	// Run inside the Epicenter: where init over f.root succeeded, f.root is one too.
	const marker = join(f.home, 'EPICENTER.md');
	await writeFile(marker, '\uFEFF---\nprot: 4748\n---\n');
	expect(
		JSON.parse((await f.runIn(f.home, '--json')).stdout).error.message,
	).toBe(`${marker}: prot is not a field; the only field is port`);
	await writeFile(marker, '\uFEFF---\nport: 4800\n---\n');
	expect((await f.runIn(f.home, '--json')).code).toBe(0);
});

test('build reports each app and keeps the last good UI after a failed build', async () => {
	const f = await setup();
	await f.folder(join(f.apps, 'capture'), {
		'code/epicenter.ts': bareApp('capture'),
	});
	const tasks = await f.folder(join(f.apps, 'tasks'), {
		'code/epicenter.ts': bareApp('tasks'),
		'code/.gitignore': 'data/\nnode_modules/\nui/dist/\n',
		'code/package.json': JSON.stringify({
			private: true,
			scripts: { build: 'bun ui/build.ts' },
		}),
		'code/ui/build.ts': `await Bun.write(\`\${process.env.EPICENTER_OUT}/index.html\`, 'good');\n`,
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
	expect(await readFile(join(tasks, 'code/ui/dist/index.html'), 'utf8')).toBe(
		'good',
	);
	await writeFile(
		join(tasks, 'code/ui/build.ts'),
		`throw new Error('build broke');\n`,
	);
	const failed = await f.run('build', 'tasks', '--json');
	expect(failed.code).toBe(1);
	expect(JSON.parse(failed.stdout).apps[0].error.message).toContain(
		'build broke',
	);
	expect(await readFile(join(tasks, 'code/ui/dist/index.html'), 'utf8')).toBe(
		'good',
	);
	expect((await f.run('build', 'capture')).stdout).toBe(
		'capture: nothing to build\n',
	);
	// A UI written by hand has no build script, and building leaves it alone.
	const capture = join(f.apps, 'capture');
	await mkdir(join(capture, 'code', 'ui', 'dist'), { recursive: true });
	await writeFile(
		join(capture, 'code', 'ui', 'package.json'),
		JSON.stringify({ name: 'ui', private: true }),
	);
	await writeFile(join(capture, 'code', 'ui', 'dist', 'index.html'), 'by hand');
	expect((await f.run('build', 'capture')).stdout).toBe(
		'capture: nothing to build\n',
	);
	expect(
		await readFile(join(capture, 'code', 'ui', 'dist', 'index.html'), 'utf8'),
	).toBe('by hand');
});

test('port 0 names no port a command could find serve at, so the marker and init refuse it', async () => {
	const f = await setup();
	const marker = join(f.home, 'EPICENTER.md');
	await writeFile(marker, '---\nport: 0\n---\n');
	for (const words of [['serve'], ['--json']]) {
		const refused = await f.run(...words);
		expect(refused.code).toBe(2);
		expect(refused.stdout + refused.stderr).toContain(
			`${marker}: port: 0 is not a whole number from 1 to 65535`,
		);
	}
	const made = await f.run('init', join(f.root, 'zero'), '--port', '0');
	expect(made.code).toBe(2);
	expect(made.stderr).toContain(
		'--port must be a whole number from 1 to 65535',
	);
	expect(await Bun.file(join(f.root, 'zero', 'EPICENTER.md')).exists()).toBe(
		false,
	);
});

test("serve reads the marker's port when no command port is given", async () => {
	const f = await setup();
	const port = await freePort();
	await writeFile(join(f.home, 'EPICENTER.md'), `---\nport: ${port}\n---\n`);
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
				if (output.includes(`Serving your apps at http://127.0.0.1:${port}.`))
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

test('init --from clones one root and installs code packages without nested repositories', async () => {
	const f = await setup();
	const source = join(f.root, 'source');
	expect((await f.run('init', source)).code).toBe(0);
	await f.folder(join(source, 'apps/x'), {
		'code/epicenter.ts': bareApp('x'),
		'code/package.json': '{"name":"x","private":true}',
		'data/a.md': 'record',
	});
	const { gitIn } = await import('./runner.test-support.ts');
	await writeFile(join(source, 'theme.css'), '/* restored palette */');
	await gitIn(source, 'add', '--', 'theme.css', 'apps/x');
	await gitIn(source, 'commit', '-qm', 'app');
	const restored = join(f.root, 'restored');
	const result = await f.run('init', restored, '--from', source, '--json');
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({
		folder: restored,
		installed: ['apps/x'],
		failed: [],
	});
	expect(result.stderr).toContain('*.local must be recreated');
	expect(await readFile(join(restored, 'theme.css'), 'utf8')).toBe(
		'/* restored palette */',
	);
	expect(
		await Bun.file(join(restored, 'apps/x/code/epicenter.ts')).exists(),
	).toBe(true);
	expect(await Bun.file(join(restored, 'apps/x/data/a.md')).exists()).toBe(
		true,
	);
	expect(await Bun.file(join(restored, 'apps/x/.git')).exists()).toBe(false);
});

test('init --from clones into the requested folder despite inherited repository redirection', async () => {
	const f = await setup();
	const source = await f.folder(
		join(f.root, 'source'),
		{ 'EPICENTER.md': '', note: 'source' },
		{ git: true },
	);
	const decoy = await f.folder(
		join(f.root, 'decoy'),
		{ note: 'decoy' },
		{ git: true },
	);
	const before = await gitIn(decoy, 'rev-parse', 'HEAD');
	const index = await readFile(join(decoy, '.git/index'));
	f.env.GIT_DIR = join(decoy, '.git');
	f.env.GIT_WORK_TREE = decoy;
	f.env.GIT_INDEX_FILE = join(decoy, '.git/index');
	const restored = join(f.root, 'restored');
	const result = await f.run('init', restored, '--from', source, '--json');
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout).folder).toBe(restored);
	expect(await readFile(join(restored, 'note'), 'utf8')).toBe('source');
	expect(await gitIn(restored, 'rev-parse', '--show-toplevel')).toBe(restored);
	expect(await gitIn(decoy, 'rev-parse', 'HEAD')).toBe(before);
	expect(await readFile(join(decoy, '.git/index'))).toEqual(index);
});

const hasLfs = (await git(import.meta.dir, ['lfs', 'version'])).code === 0;
async function lfsRestoreSource() {
	const f = await setup();
	const source = await f.folder(join(f.root, 'source'), {
		'EPICENTER.md': '',
		'.gitattributes': '*.png filter=lfs diff=lfs merge=lfs -text\n',
		'apps/x/code/epicenter.ts': bareApp('x'),
		'apps/x/code/package.json': '{"name":"x","private":true}',
	});
	const bytes = Buffer.from([137, 80, 78, 71, 0, 255, 128, 1]);
	await mkdir(join(source, 'apps/x/data'));
	await writeFile(join(source, 'apps/x/data/a.png'), bytes);
	await gitIn(source, 'init', '-q');
	await gitIn(source, 'lfs', 'install', '--local');
	await gitIn(source, 'add', '.');
	await gitIn(source, 'commit', '-qm', 'LFS record');
	const remote = join(f.root, 'origin.git');
	await gitIn(f.root, 'init', '--bare', '-q', remote);
	await gitIn(source, 'remote', 'add', 'origin', remote);
	await gitIn(source, 'push', '-qu', 'origin', 'HEAD');
	return { f, remote, bytes };
}

test.skipIf(!hasLfs)(
	'init --from materializes LFS records and installs repo-local filters on a fresh machine',
	async () => {
		const { f, remote, bytes } = await lfsRestoreSource();
		const restored = join(f.root, 'restored');
		const result = await f.run('init', restored, '--from', remote, '--json');
		expect(result.code, result.stdout + result.stderr).toBe(0);
		expect(JSON.parse(result.stdout).installed).toEqual(['apps/x']);
		expect(await readFile(join(restored, 'apps/x/data/a.png'))).toEqual(bytes);
		expect(
			await gitIn(restored, 'config', '--local', 'filter.lfs.process'),
		).toBe('git-lfs filter-process');
	},
);

test.skipIf(!hasLfs)(
	'init --from retains the clone and installs no apps when an LFS object is missing',
	async () => {
		const { f, remote } = await lfsRestoreSource();
		await rm(join(remote, 'lfs/objects'), { recursive: true });
		const restored = join(f.root, 'missing-object');
		const result = await f.run('init', restored, '--from', remote);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain('apps/x/data/a.png');
		expect(result.stderr).toContain(`Run: git -C ${restored} lfs pull`);
		expect(result.stdout).not.toContain('Restored the Epicenter');
		expect(existsSync(join(restored, '.git'))).toBe(true);
		expect(existsSync(join(restored, 'apps/x/code/node_modules'))).toBe(false);
	},
);
