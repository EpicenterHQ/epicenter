/**
 * Executable-config CLI integration tests.
 * Fresh subprocesses prove import failures, JSON reporting, strict file parsing,
 * KV presence, row null normalization, and the validator's lack of writes.
 * Launchers disable automatic installation. Trusted config can still write files,
 * bypass global console redirection, or terminate its process.
 */
import { afterEach, expect, test } from 'bun:test';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const cli = resolve(import.meta.dir, 'epicenter.ts');
const app = resolve(import.meta.dir, '../packages/app/src/index.ts');
const honeycrisp = resolve(
	import.meta.dir,
	'../apps/honeycrisp/src/lib/data.ts',
);
const temporaryFolders: string[] = [];
const config = `import { defineStore, defineTable, field } from ${JSON.stringify(app)};
export default defineStore({
  id: 'test.cli',
  kv: { label: field.nullable(field.string()) },
  tables: { notes: defineTable({ fields: {
    title: field.string(),
    optional: field.nullable(field.string()),
    jsonNull: field.json({ anyOf: [{ type: 'null' }, { type: 'string' }] }),
  } }) },
});`;

afterEach(async () => {
	await Promise.all(
		temporaryFolders
			.splice(0)
			.map((folder) => rm(folder, { recursive: true, force: true })),
	);
});

async function setup() {
	const folder = await mkdtemp(join(tmpdir(), 'epicenter-cli-test-'));
	temporaryFolders.push(folder);
	async function write(path: string, value: string | Uint8Array) {
		await mkdir(dirname(join(folder, path)), { recursive: true });
		await writeFile(join(folder, path), value);
	}
	await write('epicenter.config.ts', config);
	await write('kv.json', '{"label":null}');
	await write('notes/one.md', '---\ntitle: One\n---\nBody stays context.\n');
	function run(args = ['validate', folder, '--json']) {
		return Bun.spawnSync([process.execPath, '--no-install', cli, ...args], {
			cwd: folder,
			stdout: 'pipe',
			stderr: 'pipe',
		});
	}
	return { folder, write, run };
}

// ============================================================================
// Config execution and process boundaries
// ============================================================================

test('direct config accepts present null KV and omitted nullable row fields', async () => {
	const { folder, run } = await setup();
	const result = run();
	expect(result.exitCode).toBe(0);
	expect(JSON.parse(result.stdout.toString())).toEqual({
		config: join(folder, 'epicenter.config.ts'),
		checkedFiles: 2,
		issues: [],
		errors: [],
		exitCode: 0,
	});
});

test('an imported definition evaluates once per invocation and edits apply on the next invocation', async () => {
	const { write, run } = await setup();
	await write(
		'definition.ts',
		`console.log('definition evaluated');\n${config}`,
	);
	await write(
		'epicenter.config.ts',
		"export { default } from './definition.ts';",
	);
	const first = run();
	expect(first.exitCode).toBe(0);
	expect(first.stderr.toString().match(/definition evaluated/g)).toHaveLength(
		1,
	);
	await write(
		'definition.ts',
		config.replace('title: field.string()', 'title: field.integer()'),
	);
	const second = run();
	expect(second.exitCode).toBe(1);
	expect(JSON.parse(second.stdout.toString()).issues).toEqual([
		expect.objectContaining({ path: 'notes/one.md', field: 'title' }),
	]);
});

test('the real Honeycrisp definition imports its editor dependencies without opening an owner', async () => {
	const { folder, write, run } = await setup();
	await write(
		'epicenter.config.ts',
		`export { honeycrispDefinition as default } from ${JSON.stringify(honeycrisp)};`,
	);
	await write('kv.json', '{}');
	await mkdir(join(folder, 'folders'));
	await write(
		'notes/one.md',
		'---\ntitle: One\npinned: false\ncreatedAt: "2026-09-22T00:00:00.000Z"\nupdatedAt: "2026-09-22T00:00:00.000Z"\n---\nA body for context.\n',
	);
	const result = run();
	expect(result.stderr.toString()).toBe('');
	expect(result.exitCode).toBe(0);
	expect(JSON.parse(result.stdout.toString()).checkedFiles).toBe(2);
});

test.each([
	[
		'missing dependency',
		"import 'epicenter-test-package-that-does-not-exist';",
		'epicenter-test-package-that-does-not-exist',
	],
	[
		'evaluation failure',
		"throw new Error('config evaluation failed');",
		'config evaluation failed',
	],
	['syntax failure', 'export default {', ''],
	['missing default export', 'export const definition = {};', ''],
	['null export', 'export default null;', ''],
	[
		'invalid definition',
		'export default { id: false, kv: {}, tables: {} };',
		'invalid id',
	],
])('%s produces one structured command failure', async (_name, source, message) => {
	const { write, run } = await setup();
	await write('epicenter.config.ts', source);
	const result = run();
	const report = JSON.parse(result.stdout.toString());
	expect(result.exitCode).toBe(2);
	expect(report.exitCode).toBe(2);
	expect(report.errors).toHaveLength(1);
	expect(report.errors[0].message).toContain(message);
});

test('ordinary and deferred config diagnostics stay on stderr', async () => {
	const { write, run } = await setup();
	await write(
		'epicenter.config.ts',
		`console.log('ordinary diagnostic');\nconsole.warn('warning diagnostic');\nsetTimeout(() => console.info('deferred diagnostic'), 1);\n${config}`,
	);
	const result = run();
	expect(result.exitCode).toBe(0);
	expect(JSON.parse(result.stdout.toString()).exitCode).toBe(0);
	expect(result.stderr.toString()).toContain('ordinary diagnostic');
	expect(result.stderr.toString()).toContain('warning diagnostic');
	expect(result.stderr.toString()).toContain('deferred diagnostic');
});

test.each([
	'root script',
	'executable',
])('%s refuses missing dependencies without registry access', async (launcher) => {
	const { folder, write } = await setup();
	// A version-qualified import exercises Bun's installer even inside this repo.
	await write(
		'epicenter.config.ts',
		"import 'epicenter-test-missing-package@0.0.0';",
	);
	const requests: string[] = [];
	const registry = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request) {
			requests.push(request.url);
			return new Response('Not found', { status: 404 });
		},
	});
	const before = (await readdir(folder, { recursive: true })).sort();
	try {
		const args = ['validate', folder, '--json'];
		const child = Bun.spawn(
			launcher === 'root script'
				? [
						process.execPath,
						'run',
						'--cwd',
						resolve(import.meta.dir, '..'),
						'epicenter',
						...args,
					]
				: [cli, ...args],
			{
				cwd: folder,
				stdout: 'pipe',
				stderr: 'pipe',
				env: {
					...process.env,
					npm_config_registry: `http://127.0.0.1:${registry.port}`,
					BUN_INSTALL_CACHE_DIR: join(folder, 'install-cache'),
				},
			},
		);
		const [stdout, , exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode).toBe(2);
		expect(JSON.parse(stdout)).toMatchObject({
			exitCode: 2,
			errors: [
				expect.objectContaining({
					message: expect.stringContaining('epicenter-test-missing-package'),
				}),
			],
		});
		expect(requests).toEqual([]);
		expect((await readdir(folder, { recursive: true })).sort()).toEqual(before);
	} finally {
		registry.stop(true);
	}
});

test.each([
	"import { log } from 'node:console'; log('builtin diagnostic');",
	"import * as builtin from 'node:console'; builtin.log('builtin diagnostic');",
])('trusted builtin console exports can break JSON framing: %s', async (source) => {
	const { write, run } = await setup();
	await write('epicenter.config.ts', `${source}\n${config}`);
	const result = run();
	expect(result.exitCode).toBe(0);
	expect(result.stdout.toString()).toStartWith('builtin diagnostic\n');
	expect(() => JSON.parse(result.stdout.toString())).toThrow();
});

test('trusted config can write files even though validation makes no writes', async () => {
	const { folder, write, run } = await setup();
	await write(
		'epicenter.config.ts',
		`import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./config-effect.txt', import.meta.url), 'config wrote this');
${config}`,
	);
	const result = run();
	expect(result.exitCode).toBe(0);
	expect(JSON.parse(result.stdout.toString()).exitCode).toBe(0);
	expect(await readFile(join(folder, 'config-effect.txt'), 'utf8')).toBe(
		'config wrote this',
	);
});

test('trusted direct stdout writes can break the JSON report framing', async () => {
	const { write, run } = await setup();
	await write(
		'epicenter.config.ts',
		`process.stdout.write('trusted output\\n');\n${config}`,
	);
	const result = run();
	expect(result.exitCode).toBe(0);
	expect(result.stdout.toString()).toStartWith('trusted output\n');
	expect(() => JSON.parse(result.stdout.toString())).toThrow();
});

test('trusted process.exit can terminate before the validator reports', async () => {
	const { write, run } = await setup();
	await write('epicenter.config.ts', 'process.exit(7);');
	const result = run();
	expect(result.exitCode).toBe(7);
	expect(result.stdout.toString()).toBe('');
});

test('invalid arguments preserve the JSON command error boundary', async () => {
	const { run } = await setup();
	for (const args of [['--json'], ['validate', '--unknown', '--json']]) {
		const result = run(args);
		expect(result.exitCode).toBe(2);
		expect(JSON.parse(result.stdout.toString()).errors).toHaveLength(1);
	}
});

// ============================================================================
// File parsing and conformance
// ============================================================================

test.each([
	'epicenter.config.ts',
	'kv.json',
	'notes',
])('missing %s is an input error', async (path) => {
	const { folder, run } = await setup();
	await rm(join(folder, path), { recursive: true });
	const result = run();
	expect(result.exitCode).toBe(2);
	expect(JSON.parse(result.stdout.toString()).errors).toHaveLength(1);
});

test.each([
	'epicenter.config.ts',
	'kv.json',
	'notes/one.md',
])('invalid UTF-8 in %s is refused', async (path) => {
	const { write, run } = await setup();
	await write(path, new Uint8Array([0xc3, 0x28]));
	const result = run();
	expect(result.exitCode).toBe(2);
	expect(JSON.parse(result.stdout.toString()).errors).toHaveLength(1);
});

test.each([
	'{',
	'[]',
	'null',
	'{"label":1e999}',
])('invalid KV JSON %s is an input error', async (value) => {
	const { write, run } = await setup();
	await write('kv.json', value);
	const result = run();
	expect(result.exitCode).toBe(2);
	expect(JSON.parse(result.stdout.toString()).errors).toEqual([
		expect.objectContaining({ path: 'kv.json' }),
	]);
});

test.each([
	'No frontmatter',
	'---\ntitle: [\n---\n',
	'---\ntitle: One\ntitle: Two\n---\n',
	'---\ntitle: .nan\n---\n',
])('malformed or non-JSON YAML is an input error: %s', async (source) => {
	const { write, run } = await setup();
	await write('notes/one.md', source);
	const result = run();
	expect(result.exitCode).toBe(2);
	expect(JSON.parse(result.stdout.toString()).errors).toEqual([
		expect.objectContaining({ path: 'notes/one.md' }),
	]);
});

test('missing declared KV fails even when nullable while missing required row fields fail as null', async () => {
	const { write, run } = await setup();
	await write('kv.json', '{}');
	await write('notes/one.md', '---\n{}\n---\n');
	const result = run();
	expect(result.exitCode).toBe(1);
	expect(JSON.parse(result.stdout.toString()).issues).toEqual([
		expect.objectContaining({ path: 'kv.json', field: 'label' }),
		expect.objectContaining({ path: 'notes/one.md', field: 'title' }),
	]);
});

test('unknown JSON fields are accepted without becoming conformance issues', async () => {
	const { write, run } = await setup();
	await write('kv.json', '{"label":null,"other":{"nested":[1,null]}}');
	await write(
		'notes/one.md',
		'---\ntitle: One\nother: [true, null]\noptional: null\njsonNull: null\n---\n',
	);
	const result = run();
	expect(result.exitCode).toBe(0);
	expect(JSON.parse(result.stdout.toString()).issues).toEqual([]);
});

test('validation preserves file bytes, modification times, and the directory inventory', async () => {
	const { folder, write, run } = await setup();
	await write('unrelated.md', 'Unmanaged content');
	await write('.epicenter/manifest.json', '{"owned":"elsewhere"}');
	const paths = (await readdir(folder, { recursive: true })).sort();
	const before = await Promise.all(
		paths.map(async (path) => {
			const info = await stat(join(folder, path));
			return {
				path,
				mtimeMs: info.mtimeMs,
				bytes: info.isFile() ? await readFile(join(folder, path)) : null,
			};
		}),
	);
	expect(run().exitCode).toBe(0);
	expect((await readdir(folder, { recursive: true })).sort()).toEqual(paths);
	for (const { path, mtimeMs, bytes } of before) {
		expect((await stat(join(folder, path))).mtimeMs).toBe(mtimeMs);
		if (bytes) expect(await readFile(join(folder, path))).toEqual(bytes);
	}
});
