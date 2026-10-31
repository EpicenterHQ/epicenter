/**
 * `epicenter check <contract> [dir]` and `epicenter format <contract> [dir]`
 * against real directories, through fresh CLI processes, with the contract
 * as a file and as a URL (decision 35: a folder holds no `epicenter.json`).
 *
 * Key behaviors:
 * - check prints one compiler-style line per problem and exits 0, 1, or 2
 * - hidden paths (.git, .epicenter) are skipped
 * - format rewrites claimed notes in house style, leaves an unparseable one, and is idempotent
 * - a contract that cannot be read or is not well formed exits 2 and writes nothing
 */
import { afterEach, expect, test } from 'bun:test';
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const binary = process.env.EPICENTER_BIN;
const command = binary
	? [resolve(binary)]
	: [process.execPath, '--no-install', resolve(import.meta.dir, 'bin.ts')];

const contract = {
	name: 'recorder',
	collections: {
		recordings: {
			path: 'recordings/{id}.md',
			fields: { title: { type: 'string' }, durationMs: { type: 'number' } },
			required: ['title'],
		},
		audio: { path: 'recordings/{id}.{ext}' },
	},
};

const temporary: string[] = [];
afterEach(async () => {
	await Promise.all(
		temporary
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function setup() {
	const parent = await mkdtemp(join(tmpdir(), 'epicenter-contract-cli-'));
	temporary.push(parent);
	const folder = join(parent, 'data');
	const contractPath = join(parent, 'contract.json');
	await writeFile(contractPath, JSON.stringify(contract));
	async function write(path: string, value: string | Uint8Array) {
		await mkdir(dirname(join(folder, path)), { recursive: true });
		await writeFile(join(folder, path), value);
	}
	await write('recordings/a.md', '---\ntitle: A\ndurationMs: 3\n---\nBody\n');
	await write('recordings/a.m4a', new Uint8Array([1, 2]));
	function run(...args: string[]) {
		const result = Bun.spawnSync([...command, ...args], {
			cwd: parent,
			stdout: 'pipe',
			stderr: 'pipe',
		});
		return {
			exitCode: result.exitCode,
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		};
	}
	/** `run` without blocking this process, for a server it serves itself. */
	async function runAsync(...args: string[]) {
		const child = Bun.spawn([...command, ...args], {
			cwd: parent,
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { exitCode, stdout, stderr };
	}
	const text = (path: string) => readFile(join(folder, path), 'utf8');
	return { parent, folder, contractPath, write, run, runAsync, text };
}

test('check passes a folder whose files fit, skipping hidden paths', async () => {
	const { folder, contractPath, write, run } = await setup();
	await write('.obsidian/workspace.json', '{}');
	await write('.gitattributes', '* text\n');
	const result = run('check', contractPath, folder);
	expect(result).toMatchObject({
		exitCode: 0,
		stdout: '2 files fit; 0 files do not.\n',
	});
});

test('check names each problem compiler style and exits 1', async () => {
	const { folder, contractPath, write, run } = await setup();
	await write('recordings/b.md', '---\ntitle: B\ndurationMs: long\n---\n');
	await write('recordings/c.md', '---\ntitle: [open\n---\n');
	await write('stray.txt', 'x');
	const result = run('check', contractPath, folder);
	expect(result.exitCode).toBe(1);
	expect(result.stdout).toContain('recordings/b.md:3: durationMs');
	expect(result.stdout).toContain('recordings/c.md:3:');
	expect(result.stdout).toContain(
		'stray.txt: No file collection of this contract names this path',
	);
	expect(result.stdout).toEndWith('2 files fit; 3 files do not.\n');
	const json = JSON.parse(run('check', contractPath, folder, '--json').stdout);
	expect(json.exitCode).toBe(1);
	expect(json.files).toBe(5);
	expect(json.issues.map(({ path }: { path: string }) => path)).toEqual([
		'recordings/b.md',
		'recordings/c.md',
		'stray.txt',
	]);
});

test('check takes the contract as a URL, and the folder defaults to the working directory', async () => {
	const { folder, runAsync } = await setup();
	const server = Bun.serve({
		port: 0,
		fetch: (request) =>
			new URL(request.url).pathname === '/contract.json'
				? Response.json(contract)
				: new Response('missing', { status: 404 }),
	});
	try {
		const url = `http://localhost:${server.port}/contract.json`;
		expect((await runAsync('check', url, folder)).exitCode).toBe(0);
		const missing = await runAsync(
			'check',
			`http://localhost:${server.port}/nope.json`,
			folder,
		);
		expect(missing.exitCode).toBe(2);
		expect(missing.stderr).toContain('404');
		// From the parent, the folder argument defaults to `.`: the parent
		// holds contract.json, which no collection names.
		const here = await runAsync('check', url);
		expect(here.exitCode).toBe(1);
		expect(here.stdout).toContain('contract.json: No file collection');
	} finally {
		server.stop(true);
	}
});

test('a contract that cannot be read or is not well formed, or a missing folder, exits 2 and creates nothing', async () => {
	const { parent, folder, contractPath, run } = await setup();
	expect(run('check', join(parent, 'none.json'), folder).exitCode).toBe(2);
	await writeFile(contractPath, '{"name": "recorder",');
	const notJson = run('check', contractPath, folder, '--json');
	expect(notJson.exitCode).toBe(2);
	expect(JSON.parse(notJson.stdout).error).toContain('not JSON');
	await writeFile(
		contractPath,
		JSON.stringify({ name: 'recorder', collections: {} }),
	);
	const malformed = run('format', contractPath, folder);
	expect(malformed.exitCode).toBe(2);
	expect(malformed.stderr).toContain('declares no collections');
	await writeFile(contractPath, JSON.stringify(contract));
	const typo = join(parent, 'typo');
	expect(run('check', contractPath, typo).exitCode).toBe(2);
	expect(run('format', contractPath, typo).exitCode).toBe(2);
	await expect(stat(typo)).rejects.toThrow();
});

test('format rewrites claimed notes in the contract key order, leaves the rest, and is idempotent', async () => {
	const { folder, contractPath, write, run, text } = await setup();
	await write(
		'recordings/a.md',
		'---\nmood: calm\ndurationMs: 3\ntitle: "A"\n---\nBody\n',
	);
	await write('recordings/b.md', '---\ntitle: [open\n---\nKeep me\n');
	await write('notes/other.md', '---\nz: 1\na: 2\n---\n');
	const result = run('format', contractPath, folder);
	expect(result.exitCode).toBe(1);
	expect(result.stdout).toContain('formatted recordings/a.md');
	expect(result.stdout).toContain('recordings/b.md: line 3:');
	expect(await text('recordings/a.md')).toBe(
		'---\ntitle: A\ndurationMs: 3\nmood: calm\n---\nBody\n',
	);
	expect(await text('recordings/b.md')).toBe(
		'---\ntitle: [open\n---\nKeep me\n',
	);
	expect(await text('notes/other.md')).toBe('---\nz: 1\na: 2\n---\n');
	await write('recordings/b.md', '---\ntitle: B\n---\n');
	const again = JSON.parse(
		run('format', contractPath, folder, '--json').stdout,
	);
	expect(again).toEqual({
		formatted: [],
		unchanged: 2,
		refused: [],
		exitCode: 0,
	});
});
