/**
 * Local Pattern Tests
 *
 * A folder's `epicenter.json` lists in `local` the files that stay on the
 * machine that wrote them. A directory's history leaves the files they match
 * out of what Sync commits and sends, whatever `.gitignore` says.
 *
 * Key behaviors:
 * - Patterns that cannot be one ignoring line are refused at the declaration
 * - History reads `local` strictly and nothing else of the file: tables no
 *   app can prepare do not matter, an unknown key or a pattern that is not
 *   one ignoring line does
 * - Sync sends the rows and never a local file: not without a `.gitignore`,
 *   and not past a person's `!` exception
 * - A history keeps every pattern it has seen: a rule removed from the file
 *   while it runs, even during a Sync, still keeps its files out
 * - A history opened with a policy refuses to record once the file is gone
 *   or cannot be used
 * - No pattern may keep `epicenter.json` itself local
 * - A commit takes what stays local from the `epicenter.json` bytes it
 *   records, so a file changed between the commit's start and its capture
 *   still holds: a new rule keeps its files out, and a file gone or unusable
 *   by then records nothing
 * - A rule saved while Sync publishes the remote's `epicenter.json` survives
 *   the publish, or stops it before any file changes when the merged file
 *   would drop a rule the remote newly declares
 *
 * See also:
 * - `local-declaration.test.ts` for `local` read from `epicenter.json` by
 *   `runHistory`, a file committed before the rule, and a remote that
 *   declares a rule
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { defineFolder } from './bun.js';
import { parseLocalPolicy } from './declaration.js';
import { openDirectoryHistory } from './directory-history.test-support.js';
import {
	GIT_ENV,
	git,
	initWithOrigin,
	scratch,
} from './git-http.test-support.js';

const POLICY = '{"local":["audio/"]}';
const author = { name: 'Recorder', email: 'recorder@example.test' };
const originalGlobal = process.env.GIT_CONFIG_GLOBAL;
const roots: string[] = [];
const encode = (text: string) => new TextEncoder().encode(text);

beforeAll(() => {
	process.env.GIT_CONFIG_GLOBAL = GIT_ENV.GIT_CONFIG_GLOBAL;
});
afterAll(() => {
	if (originalGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
	else process.env.GIT_CONFIG_GLOBAL = originalGlobal;
});
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

for (const [name, local] of [
	['a comment', ['# audio']],
	['a negation', ['!recordings/*.md']],
	['two lines', ['a\nb']],
	['surrounding whitespace', [' recordings/ ']],
	['an empty pattern', ['']],
] as const)
	test(`${name} is refused at the declaration`, () => {
		expect(() => defineFolder({ tables: {}, local: [...local] })).toThrow();
	});

test("history reads local alone, whatever the file's tables say", () => {
	for (const [text, local] of [
		[POLICY, ['audio/']],
		['{"tables":{}}', []],
		['{}', []],
		[
			'{"$schema":"x","title":"Takes","local":["audio/","*.tmp"]}',
			['audio/', '*.tmp'],
		],
		// Tables no app could prepare are an app's problem, not history's.
		['{"local":["audio/"],"tables":{"takes":{"type":"string"}}}', ['audio/']],
		['{"local":["audio/"],"tables":5}', ['audio/']],
	] as const)
		expect(expectOk(parseLocalPolicy(encode(text)))).toEqual([...local]);
});

test('history refuses malformed JSON with a diagnostic', () => {
	for (const text of ['{"local":', '{"local":["audio/"],}']) {
		const { reason } = expectErr(parseLocalPolicy(encode(text)));
		expect(reason).not.toBe('');
	}
});

test('history refuses a file whose local it cannot be sure of', () => {
	for (const [bytes, reason] of [
		[new Uint8Array([0xff, 0xfe]), 'not UTF-8'],
		[encode('["audio/"]'), 'must be a JSON object'],
		[encode('{"Local":["audio/"]}'), "unknown top-level key 'Local'"],
		[
			encode('{"local":["audio/"],"tabels":{}}'),
			"unknown top-level key 'tabels'",
		],
		[encode('{"local":"audio/"}'), "'local' must list"],
		[encode('{"local":[3]}'), 'nonempty string'],
		[encode('{"local":[""]}'), 'nonempty string'],
		[encode('{"local":["!audio/x.wav"]}'), 'negation'],
		[encode('{"local":["# audio"]}'), 'comment'],
		[encode('{"local":["audio/\\nrecordings/"]}'), 'one line'],
		[encode('{"local":[" audio/"]}'), 'surrounding whitespace'],
	] as const)
		expect(expectErr(parseLocalPolicy(bytes)).reason).toContain(reason);
});

test('history refuses a pattern that would keep epicenter.json itself local', () => {
	for (const pattern of [
		'epicenter.json',
		'/epicenter.json',
		'*.json',
		'epicenter*',
		'*',
	])
		expect(
			parseLocalPolicy(encode(JSON.stringify({ local: ['audio/', pattern] })))
				.error?.reason,
		).toContain('matches epicenter.json itself');
	// Patterns that cannot match the root file are a policy.
	expect(
		expectOk(
			parseLocalPolicy(
				encode(
					'{"local":["epicenter.json/","drafts/epicenter.json","audio/*.json"]}',
				),
			),
		),
	).toEqual(['epicenter.json/', 'drafts/epicenter.json', 'audio/*.json']);
});

/**
 * A directory with a recording's row and audio and the policy in
 * `epicenter.json`, syncing to a bare remote on disk.
 */
async function recorded(
	files: Record<string, string> = {},
	options: {
		beforeGit?: (args: readonly string[]) => Promise<void>;
		local?: readonly string[];
	} = {},
) {
	const root = await scratch('local-native-');
	roots.push(root);
	const bare = join(root, 'remote.git');
	await git(root, 'init', '--quiet', '--bare', '--initial-branch=main', bare);
	const directory = join(root, 'folder');
	await initWithOrigin(directory, bare);
	const write = async (path: string, text: string) => {
		await mkdir(dirname(join(directory, path)), { recursive: true });
		await writeFile(join(directory, path), text);
	};
	for (const [path, text] of Object.entries({
		'epicenter.json': POLICY,
		'recordings/walk.md': '---\ntitle: walk\n---\n',
		'audio/walk.wav': 'RIFF',
		...files,
	}))
		await write(path, text);
	const folder = await openDirectoryHistory({
		root: directory,
		local: options.local ?? ['audio/'],
		git: { author },
		beforeGit: options.beforeGit,
	});
	const remoteTree = async () =>
		(await git(bare, 'ls-tree', '-r', '--name-only', 'main'))
			.split('\n')
			.sort();
	return { folder, directory, bare, write, remoteTree };
}

test('without a .gitignore, Sync still leaves the audio out', async () => {
	const { folder, remoteTree } = await recorded();
	try {
		expect(expectOk(await folder.sync.run())).toMatchObject({ kind: 'synced' });
		expect(await remoteTree()).toEqual([
			'epicenter.json',
			'recordings/walk.md',
		]);
	} finally {
		await folder.close();
	}
});

test("a person's ! exception in .gitignore does not get the audio committed", async () => {
	// Plain `git add -A` would take audio/walk.wav.
	const { folder, remoteTree } = await recorded({
		'.gitignore': 'audio/*\n!audio/walk.wav\n',
	});
	try {
		expect(expectOk(await folder.sync.run())).toMatchObject({ kind: 'synced' });
		expect(await remoteTree()).toEqual([
			'.gitignore',
			'epicenter.json',
			'recordings/walk.md',
		]);
	} finally {
		await folder.close();
	}
});

test('a rule removed from epicenter.json while the history is open still keeps its files out', async () => {
	const { folder, directory, write } = await recorded();
	try {
		await write('epicenter.json', '{"tables":{}}');
		await write('audio/later.wav', 'RIFF later');
		expect((await folder.git.commit()).status).toBe('committed');
		expect(await git(directory, 'ls-files')).toBe(
			'epicenter.json\nrecordings/walk.md',
		);
		expect(await readFile(join(directory, 'audio/later.wav'), 'utf8')).toBe(
			'RIFF later',
		);
	} finally {
		await folder.close();
	}
});

test('a rule removed while Sync runs still keeps its files out of the commit Sync records and sends', async () => {
	let removeRule = false;
	const setup = await recorded(
		{},
		{
			// Once the checkpoint is made: the person drops the rule, and
			// makes a file where the remote adds one, so Sync records again.
			async beforeGit(args) {
				if (!removeRule || args[0] !== 'fetch') return;
				removeRule = false;
				await setup.write('epicenter.json', '{"tables":{}}');
				await setup.write('recordings/run.md', '---\ntitle: mine\n---\n');
			},
		},
	);
	const { folder, directory, bare, remoteTree } = setup;
	try {
		expect(expectOk(await folder.sync.run())).toMatchObject({ kind: 'synced' });
		const other = join(directory, '..', 'other');
		await git(directory, 'clone', '--quiet', bare, other);
		await writeFile(join(other, 'recordings/run.md'), '---\ntitle: run\n---\n');
		await git(other, 'add', '--all');
		await git(other, 'commit', '--quiet', '-m', 'Run');
		await git(other, 'push', '--quiet', 'origin', 'main');
		removeRule = true;
		expectOk(await folder.sync.run());
		// The file made here was recorded and merged with the remote's.
		expect(await git(directory, 'log', '-1', '--format=%P')).toContain(' ');
		expect(await remoteTree()).toEqual([
			'epicenter.json',
			'recordings/run.md',
			'recordings/walk.md',
		]);
		expect(
			await git(directory, 'rev-list', '--all', '--objects', '--', 'audio'),
		).toBe('');
		expect(await readFile(join(directory, 'audio/walk.wav'), 'utf8')).toBe(
			'RIFF',
		);
	} finally {
		await folder.close();
	}
});

/**
 * A directory whose next commit, once begun, meets `change` just before it
 * captures the files: as it pins its parent, the branch read that follows
 * its check for an unfinished publish, where a policy read before the
 * capture would already be stale.
 */
async function racing() {
	let change: (() => Promise<unknown>) | undefined;
	let checkedPublish = false;
	const setup = await recorded(
		{},
		{
			async beforeGit(args) {
				if (change === undefined || args[0] !== 'rev-parse') return;
				if (args.some((arg) => arg.startsWith('refs/epicenter/publishing')))
					checkedPublish = true;
				if (
					!checkedPublish ||
					!args.some((arg) => arg.startsWith('refs/heads/main'))
				)
					return;
				const now = change;
				change = undefined;
				checkedPublish = false;
				await now();
			},
		},
	);
	return {
		...setup,
		/** Commit, with `during` made between the commit's start and its capture. */
		async commitWhile(during: () => Promise<unknown>) {
			change = during;
			const outcome = await setup.folder.git.commit();
			expect(change).toBeUndefined();
			return outcome;
		},
	};
}

test('a commit leaves out what the epicenter.json it records keeps local, though the file changed after the commit began', async () => {
	const { folder, directory, write, commitWhile } = await racing();
	try {
		const policy = '{"local":["audio/","drafts/"]}';
		const outcome = await commitWhile(async () => {
			await write('epicenter.json', policy);
			await write('drafts/plan.md', 'plan');
		});
		expect(outcome.status).toBe('committed');
		expect(await git(directory, 'show', 'HEAD:epicenter.json')).toBe(policy);
		expect(await git(directory, 'ls-files')).toBe(
			'epicenter.json\nrecordings/walk.md',
		);
		expect(await readFile(join(directory, 'drafts/plan.md'), 'utf8')).toBe(
			'plan',
		);
	} finally {
		await folder.close();
	}
});

test('a commit whose captured epicenter.json is gone or cannot be used records nothing, though the file was fine as it began', async () => {
	const { folder, directory, commitWhile } = await racing();
	try {
		for (const [change, reason] of [
			[
				() => rm(join(directory, 'epicenter.json')),
				'epicenter.json was removed',
			],
			[
				() =>
					writeFile(join(directory, 'epicenter.json'), '{"local":["*.json"]}'),
				'matches epicenter.json itself',
			],
		] as const) {
			const outcome = await commitWhile(change);
			expect(outcome.status).toBe('blocked');
			expect(JSON.stringify(outcome)).toContain(reason);
			expect(await git(directory, 'rev-list', '--all')).toBe('');
			await writeFile(join(directory, 'epicenter.json'), POLICY);
		}
	} finally {
		await folder.close();
	}
});

test('a history opened with a policy refuses to record once epicenter.json is gone or cannot be used', async () => {
	const { folder, directory } = await recorded();
	try {
		for (const [change, reason] of [
			[
				() => rm(join(directory, 'epicenter.json')),
				'epicenter.json was removed',
			],
			[
				() =>
					writeFile(join(directory, 'epicenter.json'), '{"Local":["audio/"]}'),
				"unknown top-level key 'Local'",
			],
		] as const) {
			await change();
			const outcome = await folder.git.commit();
			expect(outcome.status).toBe('blocked');
			expect(JSON.stringify(outcome)).toContain(reason);
			expect(await git(directory, 'rev-list', '--all')).toBe('');
		}
	} finally {
		await folder.close();
	}
});

/**
 * A synced directory whose `epicenter.json` is `start`, and a remote where
 * another device has since committed `remote` in its place. `syncWhile`
 * syncs with `change` made once Sync has begun publishing the remote's tree
 * here, as it marks the publish: after every check made before the publish
 * took the save lock.
 */
async function publishingWhile(start: string, remote: string) {
	let change: (() => Promise<unknown>) | undefined;
	const setup = await recorded(
		{ 'epicenter.json': start },
		{
			async beforeGit(args) {
				if (
					change === undefined ||
					args[0] !== 'update-ref' ||
					!args.includes('refs/epicenter/publishing') ||
					args.includes('-d')
				)
					return;
				const now = change;
				change = undefined;
				await now();
			},
		},
	);
	const { folder, directory, bare } = setup;
	expect(expectOk(await folder.sync.run())).toMatchObject({ kind: 'synced' });
	const other = join(directory, '..', 'other');
	await git(directory, 'clone', '--quiet', bare, other);
	await writeFile(join(other, 'epicenter.json'), remote);
	await git(other, 'commit', '--quiet', '-am', 'Change the policy');
	await git(other, 'push', '--quiet', 'origin', 'main');
	return {
		...setup,
		synced: await git(directory, 'rev-parse', 'HEAD'),
		remoteHead: await git(bare, 'rev-parse', 'main'),
		async syncWhile(during: () => Promise<unknown>) {
			change = during;
			const outcome = await folder.sync.run();
			expect(change).toBeUndefined();
			return outcome;
		},
	};
}

test("a rule saved while Sync publishes the remote's epicenter.json here survives the publish, and the next version records it", async () => {
	const { folder, directory, bare, write, remoteHead, syncWhile } =
		await publishingWhile(
			'{\n  "title": "Takes",\n  "local": ["audio/"]\n}\n',
			'{\n  "title": "Walks",\n  "local": ["audio/"]\n}\n',
		);
	try {
		const outcome = await syncWhile(async () => {
			await write(
				'epicenter.json',
				'{\n  "title": "Takes",\n  "local": ["audio/", "drafts/"]\n}\n',
			);
			await write('drafts/plan.md', 'plan');
		});
		expectOk(outcome);
		expect(await git(directory, 'rev-parse', 'HEAD')).toBe(remoteHead);
		// The remote's title and the rule saved here, both.
		const both =
			'{\n  "title": "Walks",\n  "local": ["audio/", "drafts/"]\n}\n';
		expect(await readFile(join(directory, 'epicenter.json'), 'utf8')).toBe(
			both,
		);
		expect((await folder.git.commit()).status).toBe('committed');
		expect(await git(directory, 'ls-files')).toBe(
			'epicenter.json\nrecordings/walk.md',
		);
		expectOk(await folder.sync.run());
		expect(await git(bare, 'show', 'main:epicenter.json')).toBe(both.trimEnd());
		expect(
			await git(bare, 'log', '--all', '--format=', '--name-only'),
		).not.toContain('drafts/');
	} finally {
		await folder.close();
	}
});

test('a rule saved while Sync publishes, whose merge with the remote would drop a rule the remote newly declares, stops the publish before any file changes', async () => {
	const { folder, directory, bare, write, synced, remoteHead, syncWhile } =
		await publishingWhile(POLICY, '{"local":["audio/","drafts/"]}');
	try {
		// This device's edit and the remote's are of the one line, and the
		// live file wins it: published, it would no longer list `drafts/`.
		const mine = '{"local":["audio/","notes/"]}';
		const { error } = await syncWhile(() => write('epicenter.json', mine));
		expect(error?.name).toBe('Blocked');
		const reason = (error as { reason: string }).reason;
		expect(reason).toContain(
			`merging would drop 'drafts/' from "local", which the remote's epicenter.json newly keeps on each computer, so Sync left this folder's files as they were`,
		);
		expect(await git(directory, 'rev-parse', 'HEAD')).toBe(synced);
		expect(await readFile(join(directory, 'epicenter.json'), 'utf8')).toBe(
			mine,
		);
		// Nothing is left half published for the next commit to finish.
		expect(await git(directory, 'for-each-ref', 'refs/epicenter')).toBe('');
		expect(await git(bare, 'rev-parse', 'main')).toBe(remoteHead);
		// Listing the remote's rule too, as the refusal says, Sync merges.
		const all = '{"local":["audio/","drafts/","notes/"]}';
		await write('epicenter.json', all);
		expectOk(await folder.sync.run());
		expect(await git(bare, 'show', 'main:epicenter.json')).toBe(all);
		expect(await readFile(join(directory, 'epicenter.json'), 'utf8')).toBe(all);
	} finally {
		await folder.close();
	}
});

test('a rule saved after Sync plans an unchanged policy keeps a newly protected remote file off disk', async () => {
	let addRule = false;
	const setup = await recorded(
		{ 'epicenter.json': '{"tables":{}}' },
		{
			local: [],
			async beforeGit(args) {
				if (
					!addRule ||
					args[0] !== 'update-ref' ||
					!args.includes('refs/epicenter/publishing') ||
					args.includes('-d')
				)
					return;
				addRule = false;
				await setup.write('epicenter.json', POLICY);
			},
		},
	);
	const { folder, directory, bare } = setup;
	try {
		expectOk(await folder.sync.run());
		const other = join(directory, '..', 'other');
		await git(directory, 'clone', '--quiet', bare, other);
		await writeFile(join(other, 'audio/walk.wav'), 'remote audio');
		await git(other, 'add', 'audio/walk.wav');
		await git(other, 'commit', '--quiet', '-m', 'Change audio');
		await git(other, 'push', '--quiet', 'origin', 'main');
		addRule = true;
		expectOk(await folder.sync.run());
		expect(addRule).toBe(false);
		expect(await readFile(join(directory, 'audio/walk.wav'), 'utf8')).toBe(
			'RIFF',
		);
		expect(await readFile(join(directory, 'epicenter.json'), 'utf8')).toBe(
			POLICY,
		);
		expect(await git(directory, 'rev-parse', 'HEAD')).toBe(
			await git(bare, 'rev-parse', 'main'),
		);
	} finally {
		await folder.close();
	}
});
