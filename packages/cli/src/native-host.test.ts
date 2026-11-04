/**
 * `epicenter native-host`: Chrome's framing, and the Tabs ops through a real
 * engine process in a sandbox with its own `HOME`, so nothing touches this
 * computer's library.
 *
 * Key behaviors:
 * - a frame is a little-endian byte length, then UTF-8 JSON, however stdin cuts it
 * - save writes `<library>/tabs/tabs/<timeId>.md`; list reads it back
 * - the library follows EPICENTER_ENVIRONMENT, as every other command does
 * - sync answers "not synced" until init, then syncs one round
 * - an answer over Chrome's 1 MB limit is replaced by an error
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	encodeMessage,
	MAX_HOST_MESSAGE,
	readMessages,
	serve,
} from './native-host.ts';
import {
	installNativeHost,
	nativeHostManifest,
	nativeHostWrapper,
} from './native-host-manifest.ts';

const BIN = resolve(import.meta.dir, 'bin.ts');
const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'epicenter-native-host-')));
const HOME = join(BOX, 'home');
const ENV: Record<string, string> = {
	PATH: process.env.PATH ?? '/usr/bin:/bin',
	HOME,
	TMPDIR: tmpdir(),
	GIT_CONFIG_GLOBAL: join(HOME, '.gitconfig'),
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_TERMINAL_PROMPT: '0',
	GIT_CEILING_DIRECTORIES: BOX,
	EPICENTER_DATA_DIR: join(BOX, 'data'),
};
const EXTENSION = 'abcdefghijklmnopabcdefghijklmnop';

type Tab = { id: string; url: string; title: string; savedAt: string };
type Answer = {
	ok: boolean;
	error?: string;
	item: Tab;
	items: Tab[];
	invalid: string[];
	sync?: { status: string };
};

afterAll(() => rmSync(BOX, { recursive: true, force: true }));

async function* chunks(bytes: Uint8Array, size: number) {
	for (let at = 0; at < bytes.length; at += size)
		yield bytes.subarray(at, at + size);
}

async function collect(source: AsyncIterable<unknown>) {
	const out: unknown[] = [];
	for await (const value of source) out.push(value);
	return out;
}

const concat = (...parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
};

/** Run the engine as Chrome does, send `messages`, and read every answer. */
async function host(messages: unknown[], env: Record<string, string> = {}) {
	const proc = Bun.spawn(
		['bun', BIN, 'native-host', `chrome-extension://${EXTENSION}/`],
		{
			cwd: BOX,
			env: { ...ENV, ...env },
			stdin: concat(...messages.map(encodeMessage)),
			stdout: 'pipe',
			stderr: 'pipe',
		},
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).bytes(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return {
		code,
		stderr,
		answers: (await collect(readMessages(chunks(stdout, 7)))) as Answer[],
	};
}

describe('framing', () => {
	test('a frame is a little-endian length then UTF-8 JSON', () => {
		const frame = encodeMessage({ title: 'héllo' });
		const body = JSON.stringify({ title: 'héllo' });
		const length = new TextEncoder().encode(body).length;
		expect(length).toBe(body.length + 1);
		expect([...frame.subarray(0, 4)]).toEqual([length, 0, 0, 0]);
		expect(new TextDecoder().decode(frame.subarray(4))).toBe(body);
	});

	test('messages read back however stdin cuts them', async () => {
		const stream = concat(
			encodeMessage({ op: 'list' }),
			encodeMessage({
				op: 'save',
				item: { url: 'https://a.b/', title: '日本' },
			}),
		);
		for (const size of [1, 3, stream.length])
			expect(await collect(readMessages(chunks(stream, size)))).toEqual([
				{ op: 'list' },
				{ op: 'save', item: { url: 'https://a.b/', title: '日本' } },
			]);
	});

	test('stdin ending inside a frame is an error', async () => {
		const frame = encodeMessage({ op: 'list' });
		await expect(
			collect(readMessages(chunks(frame.subarray(0, 6), 2))),
		).rejects.toThrow('inside a message');
	});

	test('an answer over 1 MB becomes an error answer', async () => {
		const written: Uint8Array[] = [];
		await serve(
			chunks(encodeMessage({ op: 'list' }), 64),
			async (bytes) => {
				written.push(bytes);
			},
			async () => ({ ok: true, items: 'x'.repeat(MAX_HOST_MESSAGE) }),
		);
		const [answer] = (await collect(
			readMessages(chunks(concat(...written), 64)),
		)) as Array<Record<string, unknown>>;
		expect(answer?.ok).toBe(false);
		expect(String(answer?.error)).toContain('at most 1048576');
	});
});

describe('the Tabs ops through the engine', () => {
	const folder = join(HOME, 'Epicenter', 'tabs');

	test('save writes a note into the Tabs folder and list reads it back', async () => {
		const { code, answers, stderr } = await host([
			{ op: 'save', item: { url: 'https://example.com/', title: 'Example' } },
			{
				op: 'save',
				item: { url: 'https://epicenter.so/', title: 'Epicenter' },
			},
			{ op: 'list' },
		]);
		expect(stderr).toBe('');
		expect(code).toBe(0);
		const [first, second, list] = answers;
		expect(first?.ok).toBe(true);
		expect(second?.ok).toBe(true);
		const id = first?.item.id as string;
		expect(id).toMatch(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-z0-9]{8}$/);
		const text = readFileSync(join(folder, 'tabs', `${id}.md`), 'utf8');
		expect(text).toBe(
			`---\nurl: "https://example.com/"\ntitle: Example\nsavedAt: "${first?.item.savedAt}"\n---\n`,
		);
		expect(list?.items.map((item) => item.url).sort()).toEqual([
			'https://epicenter.so/',
			'https://example.com/',
		]);
		expect(list?.invalid).toEqual([]);
	});

	test('a development engine writes to the development library', async () => {
		const { answers } = await host(
			[{ op: 'save', item: { url: 'https://dev.example/', title: 'Dev' } }],
			{ EPICENTER_ENVIRONMENT: 'development' },
		);
		const id = answers[0]?.item.id as string;
		expect(
			statSync(
				join(HOME, 'Epicenter Dev', 'tabs', 'tabs', `${id}.md`),
			).isFile(),
		).toBe(true);
	});

	test('bad input is answered, not fatal', async () => {
		const { code, answers } = await host([
			{ op: 'save', item: { title: 'no url' } },
			{ op: 'nope' },
			{ op: 'list' },
		]);
		expect(code).toBe(0);
		expect(answers.map((answer) => answer.ok)).toEqual([false, false, true]);
	});

	test('sync is "not synced" until init, then one round pushes the saves', async () => {
		const before = await host([{ op: 'sync' }]);
		expect(before.answers[0]).toMatchObject({ ok: false, error: 'not synced' });

		const remote = join(BOX, 'remote.git');
		const run = (cmd: string[]) =>
			Bun.spawnSync(cmd, { cwd: BOX, env: ENV, stderr: 'pipe' });
		expect(
			run(['git', 'init', '-q', '--bare', '-b', 'main', remote]).exitCode,
		).toBe(0);
		const init = run(['bun', BIN, 'init', folder]);
		expect(init.stderr.toString()).toBe('');
		expect(
			run(['bun', BIN, 'connect', folder, `file://${remote}`]).exitCode,
		).toBe(0);

		const after = await host([{ op: 'sync' }]);
		expect(after.answers[0]?.sync?.status).toBe('synced');
		const files = run([
			'git',
			'--git-dir',
			remote,
			'ls-tree',
			'-r',
			'--name-only',
			'main',
		]);
		expect(
			files.stdout
				.toString()
				.split('\n')
				.filter((path) => path.startsWith('tabs/')),
		).toHaveLength(readdirSync(join(folder, 'tabs')).length);
	});
});

describe('the host manifest', () => {
	test('names the wrapper and each extension origin', () => {
		expect(nativeHostManifest('/x/epicenter-native-host', [EXTENSION])).toEqual(
			{
				name: 'so.epicenter.engine',
				description: 'Epicenter: save to and read from your Epicenter folders.',
				path: '/x/epicenter-native-host',
				type: 'stdio',
				allowed_origins: [`chrome-extension://${EXTENSION}/`],
			},
		);
		expect(() => nativeHostManifest('/x', ['*'])).toThrow(
			'not an extension id',
		);
	});

	test('the wrapper runs the engine as native-host in its environment', () => {
		expect(
			nativeHostWrapper({
				engine: "/Users/o'k/.epicenter/bin/epicenter",
				environment: 'production',
			}),
		).toBe(
			`#!/bin/sh\n# Chrome runs this native messaging host with the caller origin as $1.\nEPICENTER_ENVIRONMENT=production exec '/Users/o'\\''k/.epicenter/bin/epicenter' native-host "$@"\n`,
		);
	});

	test('install writes an executable wrapper and one manifest per browser', async () => {
		const engine = join(BOX, 'install', '.epicenter', 'bin', 'epicenter');
		const { wrapper, manifests } = await installNativeHost({
			engine,
			environment: 'production',
			extensionIds: [EXTENSION],
			manifestDirectories: [
				join(BOX, 'install', 'a'),
				join(BOX, 'install', 'b'),
			],
		});
		expect(statSync(wrapper).mode & 0o777).toBe(0o755);
		expect(manifests).toHaveLength(2);
		for (const manifest of manifests)
			expect(JSON.parse(readFileSync(manifest, 'utf8')).path).toBe(wrapper);
	});
});
