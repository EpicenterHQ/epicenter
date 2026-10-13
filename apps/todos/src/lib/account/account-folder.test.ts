/**
 * Account Folder Tests
 *
 * The account's Todos folder gate, and the two-browser journey it allows,
 * over the in-memory OPFS stand-in. Git transfers run through the real
 * `relayFetch` and a stand-in `Account.fetch` that plays the connector's Git
 * relay: it admits only the pinned revision's path and answers from the demo's
 * `git http-backend` over a bare repository. No network.
 *
 * Key behaviors:
 * - The gate offers pairing without a pairing, Download for an absent
 *   folder, Download again for a stopped download of the same remote, opening
 *   only for the same URL and branch, and a refusal for anything else
 * - Browser A downloads the paired repository (empty), opens it, and its
 *   saves never commit; Sync records the version and pushes it
 * - Browser B, with its own storage, downloads A's history before it opens,
 *   and shows A's todo
 * - The folder records the canonical clone URL; no Git request leaves except
 *   through the relay, and none carries a credential the folder supplied
 * - Opening never creates the account folder, and a folder kept with
 *   another remote is refused unchanged
 * - The account folder and the Local demo are different folders
 */
import '../svelte-modules.test-support.js';
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { openFolder } from '@epicenter/folder/browser';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	browserStorage,
	createTestStorage,
	type TestStorage,
} from '../../../../../packages/folder/src/browser-storage.test-support.js';
import {
	createGitHandler,
	type GitSession,
	prepareGitSession,
} from '../../../server/git-server.js';
import { todosDefinition } from '../definition.js';
import { TODOS_FOLDER_ID } from '../platform/types.js';
import {
	cached,
	listing,
	observe,
	quiet,
	rowEditor,
} from '../query.test-support.js';
import {
	ACCOUNT_AUTHOR,
	accountScope,
	decideAccountFolder,
	downloadAccountFolder,
	inspectAccountFolder,
	openAccountFolder,
} from './account-folder.js';
import type { ConnectorAccount, Pairing } from './connector.js';

const { createTodos } = await import('../todos.svelte.ts');

const API = 'https://api.epicenter.test';
const REVISION = 'AbCdEfGhIjKlMnOpQrStUv';
const CANONICAL = 'https://github.com/alice/todos.git';
const pairing: Pairing = {
	folderId: TODOS_FOLDER_ID,
	revision: REVISION,
	status: 'ready',
	repository: { id: 9001, installationId: 7001, fullName: 'alice/todos' },
	remote: { url: CANONICAL, branch: 'main' },
};
const location = {
	kind: 'opfs',
	directory: 'Epicenter/accounts/x/so.epicenter.todos',
} as const;

beforeAll(() => {
	process.env.GIT_CONFIG_GLOBAL = '/dev/null';
	delete process.env.TODOS_DEMO_ROOT;
});

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

async function bareHead(session: GitSession) {
	const child = Bun.spawn(['git', 'rev-parse', '--verify', '--quiet', 'main'], {
		cwd: session.bare,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [out, code] = await Promise.all([
		new Response(child.stdout).text(),
		child.exited,
	]);
	return code === 0 ? out.trim() : undefined;
}

/**
 * An Account for `principalId` whose fetch plays the connector: it admits
 * Git requests for the folder at `revision` only, records what it was sent,
 * and answers from the demo's bare repository.
 */
function relayAccount(
	handle: (request: Request) => Promise<Response>,
	{ principalId = 'alice', revision = REVISION } = {},
) {
	const sent: { url: string; headers: string[] }[] = [];
	const account: ConnectorAccount = {
		authorityId: API,
		principalId: principalId as ConnectorAccount['principalId'],
		baseURL: API,
		fetch: async (input, init) => {
			const url = new URL(String(input));
			const headers = new Headers(init?.headers);
			sent.push({ url: url.href, headers: [...headers.keys()].sort() });
			const prefix = `/api/git/github/git/${TODOS_FOLDER_ID}/${revision}`;
			if (url.origin !== API || !url.pathname.startsWith(prefix))
				return Response.json(
					{ error: 'pairing_superseded' },
					{
						status: 409,
						headers: { 'X-Epicenter-Git-Error': 'pairing_superseded' },
					},
				);
			return handle(
				new Request(
					`http://127.0.0.1:5990/git/todos.git${url.pathname.slice(prefix.length)}${url.search}`,
					{ method: init?.method, headers, body: init?.body },
				),
			);
		},
	};
	return { account, sent };
}

describe('decideAccountFolder', () => {
	test('without a pairing it offers pairing, naming a folder already here', () => {
		expect(
			decideAccountFolder({ kind: 'absent', location }, undefined),
		).toEqual({
			kind: 'unpaired',
			existing: undefined,
		});
		expect(
			decideAccountFolder(
				{ kind: 'ready', location, remote: { url: CANONICAL, branch: 'main' } },
				undefined,
			),
		).toEqual({
			kind: 'unpaired',
			existing: { kind: 'ready', remote: { url: CANONICAL, branch: 'main' } },
		});
	});

	test('an absent folder offers Download, and a stopped download of the same remote offers it again', () => {
		expect(decideAccountFolder({ kind: 'absent', location }, pairing)).toEqual({
			kind: 'download',
			pairing,
		});
		expect(
			decideAccountFolder(
				{ kind: 'pending', location, remote: { ...pairing.remote } },
				pairing,
			),
		).toEqual({ kind: 'resume', pairing });
	});

	test('a ready folder opens only with the same URL and branch', () => {
		expect(
			decideAccountFolder(
				{ kind: 'ready', location, remote: { ...pairing.remote } },
				pairing,
			),
		).toEqual({ kind: 'open', pairing });
		for (const remote of [
			undefined,
			{ url: 'https://github.com/alice/other.git', branch: 'main' },
			{ url: CANONICAL, branch: 'trunk' },
			{ url: CANONICAL, branch: undefined },
		])
			expect(
				decideAccountFolder({ kind: 'ready', location, remote }, pairing),
			).toEqual({
				kind: 'refused',
				pairing,
				existing: { kind: 'ready', remote },
			});
	});

	test('a stopped download of another remote is refused', () => {
		const remote = {
			url: 'https://github.com/alice/other.git',
			branch: 'main',
		};
		expect(
			decideAccountFolder({ kind: 'pending', location, remote }, pairing),
		).toEqual({
			kind: 'refused',
			pairing,
			existing: { kind: 'pending', remote },
		});
	});
});

describe('the two-browser journey', () => {
	let session: GitSession;
	let handle: (request: Request) => Promise<Response>;
	beforeAll(async () => {
		session = await prepareGitSession(5990);
		handle = await createGitHandler(session);
	});

	async function openTodos(account: ConnectorAccount, storage: TestStorage) {
		const folder = expectOk(
			await openAccountFolder(account, pairing, browserStorage(storage)),
		);
		const todos = createTodos(folder);
		cleanup.push(() => todos.close());
		return todos;
	}

	test('A downloads, saves without committing, and syncs; B downloads that history before opening', async () => {
		const a = relayAccount(handle);
		const storageA = createTestStorage();

		const inspectedA = expectOk(
			await inspectAccountFolder(a.account, browserStorage(storageA)),
		);
		expect(decideAccountFolder(inspectedA, pairing).kind).toBe('download');
		const landedA = expectOk(
			await downloadAccountFolder(a.account, pairing, browserStorage(storageA)),
		);
		expect(landedA.head).toBeUndefined();

		const todosA = await openTodos(a.account, storageA);
		expect(todosA.folder.git.snapshot.remote).toMatchObject({
			url: CANONICAL,
			branch: 'main',
		});
		expectOk(await todosA.rows.create('Buy milk'));
		await quiet(todosA);
		expect(todosA.git.snapshot.lastCommit).toBeUndefined();
		expect(await bareHead(session)).toBeUndefined();

		expect(expectOk(await todosA.sync.run())).toMatchObject({ kind: 'synced' });
		const pushed = await bareHead(session);
		expect(pushed).toBeDefined();
		expect(todosA.git.snapshot.lastCommit).toMatchObject({
			status: 'committed',
		});

		// Every Git request went to the pinned relay path, with no credential of the folder's own.
		expect(a.sent.length).toBeGreaterThan(0);
		for (const { url, headers } of a.sent) {
			expect(url).toStartWith(
				`${API}/api/git/github/git/${TODOS_FOLDER_ID}/${REVISION}/`,
			);
			expect(headers).not.toContain('authorization');
		}

		const b = relayAccount(handle);
		const storageB = createTestStorage();
		const inspectedB = expectOk(
			await inspectAccountFolder(b.account, browserStorage(storageB)),
		);
		expect(decideAccountFolder(inspectedB, pairing).kind).toBe('download');
		const landedB = expectOk(
			await downloadAccountFolder(b.account, pairing, browserStorage(storageB)),
		);
		expect(landedB.head).toBe(pushed);
		expect(
			decideAccountFolder(
				expectOk(
					await inspectAccountFolder(b.account, browserStorage(storageB)),
				),
				pairing,
			).kind,
		).toBe('open');

		const todosB = await openTodos(b.account, storageB);
		cleanup.push(observe(todosB));
		await quiet(todosB);
		expect(
			listing(todosB).map((entry) => entry.result.data?.row.fields.title),
		).toEqual(['Buy milk']);
	}, 60_000);

	test('B syncs an edit back to A; competing titles wait for review without losing local text', async () => {
		const fresh = await prepareGitSession(5990);
		const relay = await createGitHandler(fresh);
		const a = relayAccount(relay);
		const b = relayAccount(relay);
		const storageA = createTestStorage();
		const storageB = createTestStorage();
		expectOk(
			await downloadAccountFolder(a.account, pairing, browserStorage(storageA)),
		);
		expectOk(
			await downloadAccountFolder(b.account, pairing, browserStorage(storageB)),
		);
		const todosA = await openTodos(a.account, storageA);
		const todosB = await openTodos(b.account, storageB);
		cleanup.push(observe(todosA), observe(todosB));
		expectOk(await todosA.rows.create('Buy milk'));
		await quiet(todosA);
		const stem = listing(todosA)[0]!.stem;
		expect(expectOk(await todosA.sync.run()).kind).toBe('synced');
		expect(expectOk(await todosB.sync.run()).kind).toBe('synced');
		await quiet(todosB);
		expect(cached(todosB, stem).row.fields.title).toBe('Buy milk');

		rowEditor(
			todosB,
			stem,
		)((row) => ({
			...row,
			fields: { ...row.fields, title: 'Buy oat milk' },
		}));
		await quiet(todosB);
		expect(expectOk(await todosB.sync.run()).kind).toBe('synced');
		expect(expectOk(await todosA.sync.run()).kind).toBe('synced');
		await quiet(todosA);
		expect(cached(todosA, stem).row.fields.title).toBe('Buy oat milk');

		rowEditor(
			todosA,
			stem,
		)((row) => ({
			...row,
			fields: { ...row.fields, title: 'Buy almond milk' },
		}));
		rowEditor(
			todosB,
			stem,
		)((row) => ({
			...row,
			fields: { ...row.fields, title: 'Buy soy milk' },
		}));
		await Promise.all([quiet(todosA), quiet(todosB)]);
		expect(expectOk(await todosB.sync.run()).kind).toBe('synced');
		const needs = expectErr(await todosA.sync.run());
		if (needs.name !== 'NeedsChoices')
			throw new Error(`Expected title review, got ${needs.message}`);
		await quiet(todosA);
		expect(cached(todosA, stem).row.fields.title).toBe('Buy almond milk');
		const titleConflict = needs.attempt.conflicts.find(
			(conflict) => conflict.kind === 'field' && conflict.field === 'title',
		);
		expect(titleConflict).toMatchObject({
			local: { present: true, value: 'Buy almond milk' },
			incoming: { present: true, value: 'Buy soy milk' },
		});
		expectOk(
			await todosA.sync.apply({
				attempt: needs.attempt,
				choices: { [titleConflict!.id]: { kind: 'take', side: 'incoming' } },
			}),
		);
		expect(expectOk(await todosB.sync.run()).kind).toBe('synced');
		await Promise.all([quiet(todosA), quiet(todosB)]);
		expect(cached(todosA, stem).row.fields.title).toBe('Buy soy milk');
		expect(cached(todosB, stem).row.fields.title).toBe('Buy soy milk');
	}, 60_000);

	test('opening never creates the account folder, and the Local demo is a different folder', async () => {
		const { account } = relayAccount(handle);
		const storage = createTestStorage();
		const local = expectOk(
			await openFolder({
				id: TODOS_FOLDER_ID,
				definition: todosDefinition,
				browser: browserStorage(storage),
			}),
		);
		cleanup.push(() => local.close());

		expect(
			expectOk(await inspectAccountFolder(account, browserStorage(storage)))
				.kind,
		).toBe('absent');
		expect(
			expectErr(
				await openAccountFolder(account, pairing, browserStorage(storage)),
			).name,
		).toBe('Absent');
		expect(
			expectOk(await inspectAccountFolder(account, browserStorage(storage)))
				.kind,
		).toBe('absent');
	});

	test('a folder kept with another remote is refused and left unchanged', async () => {
		const { account, sent } = relayAccount(handle);
		const storage = createTestStorage();
		const other = { url: 'https://github.com/alice/other.git', branch: 'main' };
		const made = expectOk(
			await openFolder({
				id: TODOS_FOLDER_ID,
				definition: todosDefinition,
				browser: {
					scope: accountScope(account),
					author: ACCOUNT_AUTHOR,
					remote: other,
					...browserStorage(storage),
				},
			}),
		);
		await made.close();
		const before = storage.opfs.files();

		const inspected = expectOk(
			await inspectAccountFolder(account, browserStorage(storage)),
		);
		expect(decideAccountFolder(inspected, pairing)).toMatchObject({
			kind: 'refused',
			existing: { kind: 'ready', remote: other },
		});
		expect(
			expectErr(
				await openAccountFolder(account, pairing, browserStorage(storage)),
			).name,
		).toBe('RemoteMismatch');
		expect(
			expectErr(
				await downloadAccountFolder(account, pairing, browserStorage(storage)),
			).name,
		).toBe('Exists');
		expect(storage.opfs.files()).toEqual(before);
		expect(sent).toEqual([]);
	});

	test("another account's folder is its own", async () => {
		const alice = relayAccount(handle);
		const bob = relayAccount(handle, { principalId: 'bob' });
		const storage = createTestStorage();
		expectOk(
			await downloadAccountFolder(
				alice.account,
				pairing,
				browserStorage(storage),
			),
		);
		expect(
			expectOk(
				await inspectAccountFolder(alice.account, browserStorage(storage)),
			).kind,
		).toBe('ready');
		expect(
			expectOk(await inspectAccountFolder(bob.account, browserStorage(storage)))
				.kind,
		).toBe('absent');
	}, 60_000);
});
