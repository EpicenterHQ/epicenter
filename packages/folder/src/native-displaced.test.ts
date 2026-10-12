/**
 * Native Displaced-Entry Tests
 *
 * What a Bun directory replacement does with the entry its one exchange
 * displaced into scratch, when that entry is not the regular file it
 * checked. The exchange and the filesystem are real; hooks act just before
 * or just after the exchange, as another program would.
 *
 * Key behaviors:
 * - The exchange is the only operation on the path. A directory, a symbolic
 *   link, or an entry that cannot be inspected is kept exactly where the
 *   exchange left it, and nothing touches the path again
 * - The write landed, so the outcome is a `Partial` whose write is both
 *   applied and failed; its `Io` error says the path changed, names where
 *   the displaced entry was kept, and says to inspect before restoring
 * - A third writer's bytes that reach the path after the exchange stay
 * - Later steps of the batch are not attempted, and a save queued behind it
 *   checks against the bytes that landed
 * - Through an opened folder the save is `Unconfirmed` carrying that report;
 *   the path is hinted, and the automatic commit records what landed, while
 *   the displaced entry stays outside history
 *
 * See also:
 * - `native-publication.test.ts` for the checks before the exchange
 */
import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test';
import * as realFs from 'node:fs/promises';
import { join, sep } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { hashBytes } from './capture.js';
import { defineFolder, defineTable, field } from './contract.js';
import { GIT_ENV, scratch } from './git-http.test-support.js';
import { exchangeSupported } from './native-exchange.js';

const real = { ...realFs };
const {
	lstat,
	mkdir,
	readdir,
	readFile,
	readlink,
	realpath,
	rm,
	symlink,
	writeFile,
} = real;

const SCRATCH = `${sep}.git${sep}epicenter${sep}scratch${sep}`;
let beforeExchange: (() => Promise<void>) | undefined;
let afterExchange: (() => Promise<void>) | undefined;
/** Exchanges of a scratch file into the folder. */
let exchanges = 0;
/** Make inspecting a scratch entry fail, as a permission error would. */
let scratchUnreadable = false;
const exchange = await import('./native-exchange.js');
const realExchange = exchange.exchangeFiles;

mock.module('node:fs/promises', () => ({
	...real,
	default: real,
	async lstat(...args: Parameters<typeof real.lstat>) {
		if (scratchUnreadable && String(args[0]).includes(SCRATCH))
			throw Object.assign(new Error('EACCES: injected inspection failure'), {
				code: 'EACCES',
			});
		return real.lstat(...args);
	},
}));
mock.module('./native-exchange.js', () => ({
	...exchange,
	async exchangeFiles(a: string, b: string) {
		if (!a.includes(SCRATCH)) return realExchange(a, b);
		exchanges++;
		await beforeExchange?.();
		await realExchange(a, b);
		await afterExchange?.();
	},
}));

const { createNativeFileBoundary } = await import('./native-store.js');
const { openNativeFolder } = await import('./directory.test-support.js');

const encoder = new TextEncoder();
const roots: string[] = [];
const originalGlobal = process.env.GIT_CONFIG_GLOBAL;

beforeAll(() => {
	process.env.GIT_CONFIG_GLOBAL = GIT_ENV.GIT_CONFIG_GLOBAL;
});
afterAll(() => {
	if (originalGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
	else process.env.GIT_CONFIG_GLOBAL = originalGlobal;
});
afterEach(async () => {
	beforeExchange = undefined;
	afterExchange = undefined;
	exchanges = 0;
	scratchUnreadable = false;
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

async function root(prefix: string) {
	const created = await realpath(await scratch(prefix));
	roots.push(created);
	return created;
}

async function replace(path: string, expectedText: string, text: string) {
	const bytes = encoder.encode(text);
	return {
		kind: 'replace' as const,
		path,
		bytes,
		sha256: await hashBytes(bytes),
		expectedSha256: await hashBytes(encoder.encode(expectedText)),
	};
}

/** The one entry left in scratch, by absolute path. */
async function kept(folder: string) {
	const directory = join(folder, '.git', 'epicenter', 'scratch');
	const names = await readdir(directory);
	expect(names).toHaveLength(1);
	return join(directory, names[0]!);
}

/** Put a directory where the file was, as another program would. */
async function directoryAt(folder: string) {
	await rm(join(folder, 'note.md'));
	await mkdir(join(folder, 'note.md'));
	await writeFile(join(folder, 'note.md', 'inside.md'), 'kept');
}

test.skipIf(!exchangeSupported)(
	'a directory displaced after the final check is kept where the exchange left it',
	async () => {
		const folder = await root('native-displaced-directory-');
		await writeFile(join(folder, 'note.md'), 'read');
		const boundary = createNativeFileBoundary(folder);
		beforeExchange = () => directoryAt(folder);

		const applyError = expectErr(
			await boundary.apply([await replace('note.md', 'read', 'mine')]),
		);

		expect(exchanges).toBe(1);
		expect(applyError.name).toBe('Partial');
		if (applyError.name !== 'Partial') return;
		expect(applyError.applied).toEqual([{ kind: 'write', path: 'note.md' }]);
		expect(applyError.failed).toEqual({ kind: 'write', path: 'note.md' });
		expect(applyError.notAttempted).toEqual([]);
		expect(applyError.error.name).toBe('Io');
		const location = await kept(folder);
		expect(applyError.error.message).toContain(location);
		expect(applyError.error.message).toContain('is a directory');
		expect(applyError.error.message).toContain('so the file there changed');
		expect(applyError.error.message).toContain(
			"Inspect 'note.md', and anything written there since, before restoring it",
		);
		expect(await readFile(join(folder, 'note.md'), 'utf8')).toBe('mine');
		expect(await readFile(join(location, 'inside.md'), 'utf8')).toBe('kept');
	},
);

test.skipIf(!exchangeSupported)(
	'a symbolic link displaced after the final check is kept, and what it names is untouched',
	async () => {
		const folder = await root('native-displaced-link-');
		const outside = await root('native-displaced-outside-');
		await writeFile(join(outside, 'target.md'), 'outside');
		await writeFile(join(folder, 'note.md'), 'read');
		const boundary = createNativeFileBoundary(folder);
		beforeExchange = async () => {
			await rm(join(folder, 'note.md'));
			await symlink(join(outside, 'target.md'), join(folder, 'note.md'));
		};

		const applyError = expectErr(
			await boundary.apply([await replace('note.md', 'read', 'mine')]),
		);

		expect(exchanges).toBe(1);
		expect(applyError.name).toBe('Partial');
		if (applyError.name !== 'Partial') return;
		const location = await kept(folder);
		expect(applyError.error.message).toContain(location);
		expect(applyError.error.message).toContain('is a symbolic link');
		expect((await lstat(location)).isSymbolicLink()).toBe(true);
		expect(await readlink(location)).toBe(join(outside, 'target.md'));
		expect(await readFile(join(outside, 'target.md'), 'utf8')).toBe('outside');
		expect(await readFile(join(folder, 'note.md'), 'utf8')).toBe('mine');
	},
);

test.skipIf(!exchangeSupported)(
	'a displaced entry that cannot be inspected is kept, even a regular file',
	async () => {
		const folder = await root('native-displaced-unreadable-');
		await writeFile(join(folder, 'note.md'), 'read');
		const boundary = createNativeFileBoundary(folder);
		afterExchange = async () => {
			scratchUnreadable = true;
		};

		const applyError = expectErr(
			await boundary.apply([await replace('note.md', 'read', 'mine')]),
		);
		scratchUnreadable = false;

		expect(applyError.name).toBe('Partial');
		if (applyError.name !== 'Partial') return;
		expect(applyError.applied).toEqual([{ kind: 'write', path: 'note.md' }]);
		const location = await kept(folder);
		expect(applyError.error.message).toContain('could not be inspected');
		expect(applyError.error.message).toContain('EACCES');
		expect(applyError.error.message).toContain(location);
		expect(await readFile(location, 'utf8')).toBe('read');
		expect(await readFile(join(folder, 'note.md'), 'utf8')).toBe('mine');
	},
);

test.skipIf(!exchangeSupported)(
	"a third writer's bytes that reach the path after the exchange stay",
	async () => {
		for (const displaced of ['directory', 'file'] as const) {
			const folder = await root(`native-displaced-third-${displaced}-`);
			await writeFile(join(folder, 'note.md'), 'read');
			const boundary = createNativeFileBoundary(folder);
			if (displaced === 'directory') beforeExchange = () => directoryAt(folder);
			afterExchange = () => writeFile(join(folder, 'note.md'), 'C');

			const { error } = await boundary.apply([
				await replace('note.md', 'read', 'mine'),
			]);

			expect(exchanges).toBe(1);
			expect(await readFile(join(folder, 'note.md'), 'utf8')).toBe('C');
			if (displaced === 'directory') {
				expect(error?.name).toBe('Partial');
				expect(
					await readFile(join(await kept(folder), 'inside.md'), 'utf8'),
				).toBe('kept');
			} else {
				// A regular file was displaced and removed; the path was not touched.
				expect(error).toBeNull();
				expect(
					await readdir(join(folder, '.git', 'epicenter', 'scratch')),
				).toEqual([]);
			}
			beforeExchange = undefined;
			exchanges = 0;
		}
	},
);

test.skipIf(!exchangeSupported)(
	'later steps are not attempted, and a save queued behind checks against what landed',
	async () => {
		const folder = await root('native-displaced-batch-');
		await writeFile(join(folder, 'note.md'), 'read');
		const boundary = createNativeFileBoundary(folder);
		beforeExchange = async () => {
			beforeExchange = undefined;
			await directoryAt(folder);
		};
		const later = encoder.encode('later');

		const [first, second] = await Promise.all([
			boundary.apply([
				await replace('note.md', 'read', 'mine'),
				{
					kind: 'create',
					path: 'later.md',
					bytes: later,
					sha256: await hashBytes(later),
				},
			]),
			boundary.apply([await replace('note.md', 'read', 'second')]),
		]);

		const partial = expectErr(first);
		expect(partial.name).toBe('Partial');
		if (partial.name !== 'Partial') return;
		expect(partial.notAttempted).toEqual([{ kind: 'write', path: 'later.md' }]);
		// One write landed and did not finish; the create never started.
		expect(partial.message).toStartWith(
			'1 of 2 file steps landed, and the last did not finish:',
		);
		expect(
			await readFile(join(folder, 'later.md')).then(
				() => true,
				() => false,
			),
		).toBe(false);
		// Nothing was rolled back: the queued save finds the landed bytes.
		const conflict = expectErr(second);
		expect(conflict.name).toBe('Conflict');
		if (conflict.name !== 'Conflict') return;
		expect(conflict.actualSha256).toBe(await hashBytes(encoder.encode('mine')));
		expect(await readFile(join(folder, 'note.md'), 'utf8')).toBe('mine');
	},
);

test.skipIf(!exchangeSupported)(
	'through an opened folder the save is Unconfirmed with the report, hinted, and what landed is committed',
	async () => {
		const folder = await root('native-displaced-opened-');
		await writeFile(join(folder, 'note.md'), 'read');
		const opened = await openNativeFolder({
			root: folder,
			definition: defineFolder({
				kv: {},
				tables: {
					todos: defineTable({ fields: { title: field.string() } }),
				},
			}),
			git: {
				author: { name: 'App', email: 'app@example.test' },
			},
		});
		try {
			const heard: string[] = [];
			opened.onFilesChanged((paths) => heard.push(...paths));
			const capture = expectOk(await opened.files.read('note.md'));
			const before = opened.git.snapshot.lastCommit;
			beforeExchange = () => directoryAt(folder);

			const unconfirmed = expectErr(
				await opened.files.replace(capture, 'mine'),
			);

			expect(unconfirmed.name).toBe('Unconfirmed');
			const location = await kept(folder);
			expect(unconfirmed.message).toContain(location);
			expect(unconfirmed.message).toContain('Inspect');
			expect(heard).toContain('note.md');
			// A commit records the folder's files as they are, so the bytes that
			// landed are committed; the displaced entry is kept under `.git`.
			for (let i = 0; i < 100 && opened.git.snapshot.lastCommit === before; i++)
				await Bun.sleep(20);
			expect(opened.git.snapshot.lastCommit).toMatchObject({
				status: 'committed',
			});
			expect(await readFile(join(folder, 'note.md'), 'utf8')).toBe('mine');
		} finally {
			await opened.close();
		}
	},
);
