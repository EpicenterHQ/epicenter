import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VERSION } from './engines.ts';
import {
	bareApp,
	fixture,
	freePort,
	gitIn,
	homePackage,
} from './runner.test-support.ts';

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
	const result = await f.init(folder, '--port', '4748', '--json');
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({
		data: { folder, port: 4748 },
		error: null,
	});
	expect(await readFile(join(folder, 'EPICENTER.md'), 'utf8')).toBe(
		'---\nport: 4748\n---\nThis folder is an Epicenter. Each folder in its `apps/` is an app: its code in `code/`, its records in `data/`. Run `epicenter` here to list them.\n',
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
	const defaulted = await f.init(fresh, '--json');
	expect(defaulted.code).toBe(0);
	expect(JSON.parse(defaulted.stdout).data.port).toBe(4747);
	expect(await readFile(join(fresh, 'EPICENTER.md'), 'utf8')).toStartWith(
		'---\nport: 4747\n---\n',
	);
	// Each app owns its palette, so a home has no theme of its own.
	expect(existsSync(join(fresh, 'theme.css'))).toBe(false);
	expect(await gitIn(fresh, 'check-ignore', 'apps/x/local/google.md')).toBe(
		'apps/x/local/google.md',
	);
	// The home is a workspace that runs this command's version, and says so in Git.
	const written = {
		private: true,
		workspaces: ['apps/*/code'],
		scripts: { build: "bun run --filter '*' --if-present build" },
		dependencies: { '@epicenter/cli': VERSION, '@epicenter/app': VERSION },
	};
	expect(JSON.parse(await gitIn(fresh, 'show', 'HEAD:package.json'))).toEqual(
		written,
	);
	expect(await gitIn(fresh, 'check-ignore', 'node_modules/x')).toBe(
		'node_modules/x',
	);
	const starter = await readFile(join(fresh, 'AGENTS.md'), 'utf8');
	expect(starter).toContain('one private Git repository');
	expect(starter).toContain('This folder is one Bun workspace');
	// The guidance shows the two files as init wrote them.
	for (const path of ['routines/checkpoint.md', 'scripts/checkpoint.sh'])
		for (const line of (await readFile(join(fresh, path), 'utf8'))
			.trimEnd()
			.split('\n'))
			expect(starter).toContain(`    ${line}\n`);
	const shown = await f.init(join(f.root, 'shown'));
	expect(shown.stdout).toContain(`Made Epicenter at ${join(f.root, 'shown')}`);
	expect(shown.stderr).toBe(
		`Run: cd ${join(f.root, 'shown')} && bun install\nRun: epicenter new <name>\n`,
	);
	// A folder that already holds an app is pointed at its listing instead.
	const holding = join(f.root, 'holding');
	await f.folder(join(holding, 'apps', 'journal'), {
		'code/epicenter.ts': bareApp('journal'),
	});
	expect((await f.init(holding)).stderr).toBe(
		`Run: cd ${holding} && bun install\nRun: epicenter\n`,
	);
	const current = join(f.root, 'current');
	await mkdir(current);
	expect(
		JSON.parse(
			(await f.runIn(current, 'init', '--no-install', '--json')).stdout,
		).data.folder,
	).toBe(current);
});

test('init installs the packages its package.json names, keeps a package.json already there, and leaves a home whose install failed ready to install again', async () => {
	const f = await setup();
	// A package.json already there is kept; this one names nothing to fetch.
	const kept = join(f.root, 'kept');
	await mkdir(kept);
	await f.folder(kept, {
		'package.json': homePackage,
		'apps/notes/code/package.json': '{ "name": "notes" }\n',
	});
	const installed = await f.run('init', kept, '--json');
	expect(installed.code).toBe(0);
	expect(JSON.parse(installed.stdout).data).toEqual({
		folder: kept,
		port: 4747,
	});
	expect(await readFile(join(kept, 'package.json'), 'utf8')).toBe(homePackage);
	// The install ran before the first commit, which holds the lock it wrote.
	expect(await gitIn(kept, 'show', 'HEAD:bun.lock')).toContain(
		'"apps/notes/code"',
	);

	const broken = join(f.root, 'broken');
	await mkdir(broken);
	await writeFile(join(broken, 'package.json'), '{ "dependencies": ');
	// It ran, so it is not NotStarted: Problems, exit 1, its report the home it
	// made, with the install as the next step.
	const failed = await f.run('init', broken, '--json');
	expect(failed.code).toBe(1);
	const { data, error } = JSON.parse(failed.stdout);
	expect(data).toBeNull();
	expect(error).toEqual({
		name: 'Problems',
		message: expect.any(String),
		report: { folder: broken, port: expect.any(Number) },
		next: `cd ${broken} && bun install`,
	});
	expect(error.message).toStartWith('Its packages did not install: ');
	// The home is made and committed, so the repair is the install alone.
	expect((await f.runIn(broken, '--json')).code).toBe(0);
	expect(await gitIn(broken, 'log', '--format=%s')).toBe('start the Epicenter');
});

test('walk-up wins over EPICENTER_ROOT, which wins over the default', async () => {
	const f = await setup();
	await f.folder(join(f.apps, 'reading'), {
		'code/epicenter.ts': bareApp('reading'),
	});
	const other = join(f.root, 'other');
	expect((await f.init(other, '--json')).code).toBe(0);
	await f.folder(join(other, 'apps', 'tasks'), {
		'code/epicenter.ts': bareApp('tasks'),
	});
	f.env.EPICENTER_ROOT = other;
	const fromOutside = JSON.parse((await f.run('--json')).stdout).data;
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
	).data;
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
	expect(JSON.parse((await listed()).stdout).data.epicenter).toBe(f.home);
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
		JSON.parse((await f.runIn(elsewhere, '--json')).stdout).data.epicenter,
	).toBe(f.home);
	expect((await f.init(join(f.root, 'beside'), '--json')).code).toBe(0);
	const over = await f.run('init', f.root, '--no-install', '--json');
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

test('a new home commits itself: the script init writes commits, pushes, waits out a rebase and refuses a nested repository', async () => {
	const f = await setup();
	const home = join(f.root, 'home');
	expect((await f.init(home)).code).toBe(0);
	expect(await gitIn(home, 'status', '--porcelain')).toBe('');
	expect(
		await gitIn(home, 'ls-files', '-s', 'scripts/checkpoint.sh'),
	).toStartWith('100755 ');
	// The routine file init wrote is one serve accepts.
	expect(
		JSON.parse((await f.runIn(home, '--json')).stdout).data.routines,
	).toEqual([
		{
			name: 'checkpoint',
			cron: '*/5 * * * *',
			next: expect.any(String),
			command: 'sh scripts/checkpoint.sh',
		},
	]);
	// As the routine runs it: serve starts routines in the home.
	const checkpoint = async () => {
		const child = Bun.spawn(['sh', 'scripts/checkpoint.sh'], {
			cwd: home,
			env: process.env,
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [stderr, code] = await Promise.all([
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { code, stderr };
	};
	const head = () => gitIn(home, 'rev-parse', 'HEAD');

	// No origin: it commits what is pending and pushes nowhere.
	// What an app keeps in local/ is never staged: the root ignore line covers
	// it whoever made the folder.
	await f.folder(home, {
		'apps/x/data/a.md': 'a',
		'apps/x/local/google.md': 'token',
	});
	expect(await checkpoint()).toEqual({ code: 0, stderr: '' });
	expect(await gitIn(home, 'log', '-1', '--format=%s')).toBe('checkpoint');
	expect(await gitIn(home, 'ls-files', '--', 'apps')).toBe('apps/x/data/a.md');
	const clean = await head();
	expect(await checkpoint()).toEqual({ code: 0, stderr: '' });
	expect(await head()).toBe(clean);

	const origin = join(f.root, 'origin.git');
	await gitIn(f.root, 'init', '-q', '--bare', origin);
	await gitIn(home, 'remote', 'add', 'origin', origin);
	await f.folder(home, { 'apps/x/data/b.md': 'b' });
	expect((await checkpoint()).code).toBe(0);
	expect(await gitIn(origin, 'rev-parse', 'main')).toBe(await head());

	await mkdir(join(home, '.git/rebase-merge'));
	await f.folder(home, { 'apps/x/data/c.md': 'c' });
	const pushed = await head();
	expect(await checkpoint()).toEqual({
		code: 0,
		stderr: 'merge or rebase underway\n',
	});
	expect(await head()).toBe(pushed);
	await rm(join(home, '.git/rebase-merge'), { recursive: true });

	await f.folder(join(home, 'apps/x/vendor'), { 'lib.ts': '' }, { git: true });
	const refused = await checkpoint();
	expect(refused.code).toBe(1);
	expect(refused.stderr).toContain(
		'a nested Git repository is staged; remove its .git',
	);
	expect(await head()).toBe(pushed);
});
