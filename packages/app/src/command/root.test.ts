import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	bareApp,
	fixture,
	freePort,
	homePackage,
	installPackages,
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

test('a command acts on the nearest Epicenter at or above it, and refuses outside any', async () => {
	const f = await setup();
	await f.folder(join(f.apps, 'reading'), {
		'code/epicenter.ts': bareApp('reading'),
	});
	const other = join(f.root, 'other');
	await f.folder(other, { 'EPICENTER.md': '', 'package.json': homePackage });
	await installPackages(other);
	await f.folder(join(other, 'apps', 'tasks'), {
		'code/epicenter.ts': bareApp('tasks'),
	});
	// The variable that once chose an Epicenter from anywhere is ignored.
	f.env.EPICENTER_ROOT = other;
	const fromInside = JSON.parse(
		(await f.runIn(join(f.apps, 'reading'), '--json')).stdout,
	).data;
	expect(fromInside.epicenter).toBe(f.home);
	expect(fromInside.apps.map((app: { name: string }) => app.name)).toEqual([
		'reading',
	]);
	for (const words of [
		['--json'],
		['reading', '--json'],
		['check', '--json'],
	]) {
		const outside = await f.runIn(f.root, ...words);
		expect(outside.code).toBe(2);
		expect(JSON.parse(outside.stdout).error).toEqual({
			name: 'NotStarted',
			cause: 'usage',
			message: 'There is no EPICENTER.md here or above; cd into your Epicenter',
		});
	}
});

test('serve starts only in its Epicenter, and from below it names the folder to start in', async () => {
	const f = await setup();
	const below = await f.folder(join(f.apps, 'reading'), {
		'code/epicenter.ts': bareApp('reading'),
	});
	const refused = await f.runIn(below, 'serve');
	expect(refused.code).toBe(2);
	expect(refused.stderr).toContain(`Run: cd ${f.home} && epicenter serve`);
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
	const elsewhere = join(f.root, 'elsewhere');
	await mkdir(elsewhere);
	expect(
		JSON.parse((await f.runIn(elsewhere, '--json')).stdout).error.message,
	).toBe('There is no EPICENTER.md here or above; cd into your Epicenter');

	const marker = join(f.home, 'EPICENTER.md');
	await writeFile(marker, '\uFEFF---\nprot: 4748\n---\n');
	expect(
		JSON.parse((await f.runIn(f.home, '--json')).stdout).error.message,
	).toBe(`${marker}: prot is not a field; the only field is port`);
	await writeFile(marker, '\uFEFF---\nport: 4800\n---\n');
	// check asks no serve, so it shows the marker reads alone.
	expect((await f.runIn(f.home, 'check', '--json')).code).toBe(0);
});

test('port 0 names no port a command could find serve at, so the marker refuses it', async () => {
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
});

test("serve reads the marker's port when no command port is given", async () => {
	const f = await setup();
	const port = await freePort();
	await writeFile(join(f.home, 'EPICENTER.md'), `---\nport: ${port}\n---\n`);
	const child = Bun.spawn([process.execPath, f.bin, 'serve'], {
		cwd: f.home,
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
