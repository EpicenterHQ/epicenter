/**
 * Real native smart-HTTP synchronization over the production IndexedDB engine.
 * Lost replies, concurrent saves and stale pages must preserve exact pending
 * commits and avoid replaying edits the server has already incorporated.
 */
import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createGitServer } from '../../smoke/git-server.js';
import { readCommit } from '../git/raw-objects.js';
import type { HttpRequest } from './git/transfer.js';
import { openRepository } from './repository.js';
import { createSync } from './sync.js';

const author = () => ({
	name: 'Browser',
	email: 'browser@example.com',
	timestamp: Math.floor(Date.now() / 1000),
});
const row = (title: string, extra = '') =>
	`---\ntitle: ${title}\n${extra}---\nFirst\n\nLast\n`;
async function fixture(initial: string | null = row('Base')) {
	const server = await createGitServer();
	if (initial !== null)
		await server.commit(new Map([['notes/one.md', initial]]));
	const id = crypto.randomUUID();
	const repository = await openRepository(id, { notes: { type: 'object' } });
	const sync = createSync(repository, { url: server.url, author });
	return {
		server,
		repository,
		sync,
		id,
		close: async () => {
			repository.close();
			await server.close();
		},
	};
}

test('offline-first edits push a native root commit to an empty server', async () => {
	const f = await fixture(null);
	try {
		expectOk(
			await f.repository.files.write('offline.txt', null, 'Saved offline'),
		);
		expect((await f.repository.storage.capture()).state.remoteKnown).toBe(
			false,
		);
		expectOk(await f.sync.run());
		expect(await f.server.git(['show', 'main:offline.txt'])).toBe(
			'Saved offline',
		);
		const snapshot = await f.repository.storage.capture('sync');
		expect(snapshot.state.base).toBe(snapshot.state.head);
		expect(snapshot.edits.size).toBe(0);
		expect(
			readCommit(snapshot.objects.get(snapshot.state.head!)!.bytes).parents,
		).toEqual([]);
		await f.server.git(['fsck', '--strict']);
	} finally {
		await f.close();
	}
}, 20000);

test('pull-only adoption collects superseded snapshots but an idle check does not sweep', async () => {
	const f = await fixture();
	try {
		let sweeps = 0;
		let removed = 0;
		const collect = f.repository.storage.collect;
		f.repository.storage.collect = async () => {
			sweeps++;
			removed = await collect();
			return removed;
		};
		expectOk(await f.sync.run());
		expect(sweeps).toBe(1);
		sweeps = 0;
		expect(expectOk(await f.sync.run()).outcome).toBe('unchanged');
		expect(sweeps).toBe(0);
		await f.server.commit(new Map([['notes/one.md', row('Remote update')]]));
		expect(expectOk(await f.sync.run()).outcome).toBe('unchanged');
		expect(sweeps).toBe(1);
		expect(removed).toBeGreaterThan(0);
		expect((await f.repository.storage.capture('sync')).edits.size).toBe(0);
	} finally {
		await f.close();
	}
}, 20000);

test('initial shallow fetch and later rejected commit preserve independent fields and a newer reversal', async () => {
	const f = await fixture(row('a'));
	try {
		const previous = (await f.server.git(['rev-parse', 'main'])).trim();
		await f.server.commit(new Map([['other.txt', 'history']]));
		expectOk(await f.sync.run());
		const initial = await f.repository.storage.capture('sync');
		expect(initial.objects.has(previous)).toBe(false);
		expect(initial.state.shallow).toEqual([initial.state.head!]);
		let draft = expectOk(await f.repository.tables.notes.get('one'))!;
		draft = expectOk(
			await f.repository.tables.notes.set('one', draft, {
				fields: { title: 'b' },
			}),
		).sent;
		expectOk(await f.repository.prepareCommit(author()));
		expectOk(
			await f.repository.tables.notes.set('one', draft, {
				fields: { title: 'a', local: 1 },
			}),
		);
		const remote = await f.server.commit(
			new Map([['notes/one.md', row('c', 'remote: 1\n')]]),
		);
		expectOk(await f.sync.run());
		const result = expectOk(await f.repository.tables.notes.get('one'))!;
		expect(result.fields).toEqual({ title: 'a', remote: 1, local: 1 });
		expect((await f.server.git(['rev-parse', 'main^'])).trim()).toBe(remote);
		expect(await f.server.git(['log', '-1', '--format=%B'])).toContain(
			`Overrode: ${remote} field="title" "notes/one.md"`,
		);
		await f.server.git(['fsck', '--strict']);
	} finally {
		await f.close();
	}
}, 20000);

for (const secondParent of [false, true])
	test(`lost push reply followed by a native edit does not replay the accepted title${secondParent ? ' through a second parent' : ''}`, async () => {
		const f = await fixture();
		try {
			expectOk(await f.sync.run());
			const before = (await f.repository.storage.capture('sync')).state.base!;
			let lose = true;
			const request: HttpRequest = async (input, init) => {
				const response = await fetch(input, init);
				if (
					lose &&
					init?.method === 'POST' &&
					String(input).endsWith('/git-receive-pack')
				) {
					lose = false;
					await response.arrayBuffer();
					throw new TypeError(
						'Reply deliberately lost after server completion',
					);
				}
				return response;
			};
			const lossy = createSync(f.repository, {
				url: f.server.url,
				author,
				request,
			});
			const base = expectOk(await f.repository.tables.notes.get('one'))!;
			expectOk(
				await f.repository.tables.notes.set('one', base, {
					fields: { title: 'Blue' },
				}),
			);
			expect(expectErr(await lossy.run()).name).toBe('TransferFailed');
			const pending = (await f.repository.storage.capture('sync')).state.head!;
			expect((await f.server.git(['rev-parse', 'main'])).trim()).toBe(pending);
			const native = await f.server.commit(
				new Map([['notes/one.md', row('Green', 'remote: 1\n')]]),
			);
			if (secondParent) {
				const oldTree = (
					await f.server.git(['rev-parse', `${before}^{tree}`])
				).trim();
				const branch = (
					await f.server.git(
						['commit-tree', oldTree, '-p', before],
						'Independent branch\n',
					)
				).trim();
				const tree = (
					await f.server.git(['rev-parse', `${native}^{tree}`])
				).trim();
				const merged = (
					await f.server.git(
						['commit-tree', tree, '-p', branch, '-p', native],
						'Native merge\n',
					)
				).trim();
				await f.server.git(['update-ref', 'refs/heads/main', merged, native]);
			}
			const draft = expectOk(await f.repository.tables.notes.get('one'))!;
			expectOk(
				await f.repository.tables.notes.set('one', draft, {
					fields: { local: 1 },
				}),
			);
			expectOk(await f.sync.run());
			expect(
				expectOk(await f.repository.tables.notes.get('one'))!.fields,
			).toEqual({ title: 'Green', remote: 1, local: 1 });
			expect(await f.server.git(['show', 'main:notes/one.md'])).toContain(
				'title: Green',
			);
			expect(
				(await f.server.git(['rev-list', 'main']))
					.split('\n')
					.filter((oid) => oid === pending),
			).toHaveLength(1);
			await f.server.git(['fsck', '--strict']);
		} finally {
			await f.close();
		}
	}, 20000);

test('a request lost before acceptance retries the identical pending commit', async () => {
	const f = await fixture();
	try {
		expectOk(await f.sync.run());
		const request: HttpRequest = async (input, init) => {
			if (
				init?.method === 'POST' &&
				String(input).endsWith('/git-receive-pack')
			)
				throw new TypeError('Dropped before sending');
			return fetch(input, init);
		};
		expectOk(await f.repository.files.write('pending.txt', null, 'Pending'));
		expectErr(
			await createSync(f.repository, {
				url: f.server.url,
				author,
				request,
			}).run(),
		);
		const pending = (await f.repository.storage.capture('sync')).state.head!;
		expectOk(await f.repository.files.write('newer.txt', null, 'Newer'));
		expectOk(await f.sync.run());
		const after = await f.repository.storage.capture('sync');
		expect(after.state.base).toBe(pending);
		expect(after.state.head).toBe(pending);
		expect(after.edits.get('newer.txt')).toBe('Newer');
		expect((await f.server.git(['rev-parse', 'main'])).trim()).toBe(pending);
	} finally {
		await f.close();
	}
}, 20000);

test('a save between adoption capture and publication rejects cleanup and survives the next attempt', async () => {
	const f = await fixture();
	try {
		expectOk(await f.sync.run());
		const remote = await f.server.commit(new Map([['remote.txt', 'Remote']]));
		const publish = f.repository.storage.publish;
		let inject = true;
		f.repository.storage.publish = async (input) => {
			if (inject && input.refs?.base === remote) {
				inject = false;
				expectOk(
					await f.repository.files.write(
						'new-path.txt',
						null,
						'Saved during adoption',
					),
				);
			}
			return publish(input);
		};
		expect(expectOk(await f.sync.run()).outcome).toBe('pending');
		expect(
			(await f.repository.storage.capture()).edits.get('new-path.txt'),
		).toBe('Saved during adoption');
		expectOk(await f.sync.run());
		expect(await f.server.git(['show', 'main:new-path.txt'])).toBe(
			'Saved during adoption',
		);
		expect(await f.server.git(['show', 'main:remote.txt'])).toBe('Remote');
	} finally {
		await f.close();
	}
}, 20000);

test('a suspended old push cannot rewind two tabs that already advanced and newer saves survive its reply', async () => {
	const f = await fixture();
	const other = await openRepository(f.id, { notes: { type: 'object' } });
	try {
		expectOk(await f.sync.run());
		const held = Promise.withResolvers<void>(),
			resume = Promise.withResolvers<void>();
		const request: HttpRequest = async (input, init) => {
			if (
				init?.method === 'POST' &&
				String(input).endsWith('/git-receive-pack')
			) {
				held.resolve();
				await resume.promise;
			}
			return fetch(input, init);
		};
		const old = createSync(f.repository, {
			url: f.server.url,
			author,
			request,
		});
		expectOk(await f.repository.files.write('first.txt', null, 'First'));
		const oldAttempt = old.run();
		expect(old.run()).toBe(oldAttempt);
		await held.promise;
		const otherSync = createSync(other, { url: f.server.url, author });
		expectOk(await otherSync.run());
		expectOk(await other.files.write('second.txt', null, 'Second'));
		expectOk(await otherSync.run());
		const newest = (await f.server.git(['rev-parse', 'main'])).trim();
		resume.resolve();
		expectOk(await oldAttempt);
		expect((await f.repository.storage.capture()).state.base).toBe(newest);
		expect((await f.server.git(['rev-parse', 'main'])).trim()).toBe(newest);
		expect(await f.server.git(['show', 'main:first.txt'])).toBe('First');
		expect(await f.server.git(['show', 'main:second.txt'])).toBe('Second');
	} finally {
		other.close();
		await f.close();
	}
}, 20000);

for (const localDelete of [false, true])
	test(`an unseen ${localDelete ? 'local' : 'remote'} deletion loses to an independent edit`, async () => {
		const f = await fixture('Base\n');
		try {
			expectOk(await f.sync.run());
			if (localDelete)
				expectOk(await f.repository.files.delete('notes/one.md', 'Base\n'));
			else
				expectOk(
					await f.repository.files.write(
						'notes/one.md',
						'Base\n',
						'Edited locally\n',
					),
				);
			await f.server.commit(
				new Map([['notes/one.md', localDelete ? 'Edited remotely\n' : null]]),
			);
			expectOk(await f.sync.run());
			expect(await f.server.git(['show', 'main:notes/one.md'])).toBe(
				localDelete ? 'Edited remotely\n' : 'Edited locally\n',
			);
		} finally {
			await f.close();
		}
	}, 20000);

for (const existed of [false, true])
	test(`a newer deletion removes the rejected commit's contribution from a ${existed ? 'modified' : 'created'} file`, async () => {
		const f = await fixture();
		try {
			if (existed) await f.server.commit(new Map([['p.txt', 'a\n']]));
			expectOk(await f.sync.run());
			const local = existed ? 'a\nline1\n' : 'line1\n';
			expectOk(
				await f.repository.files.write('p.txt', existed ? 'a\n' : null, local),
			);
			expectOk(await f.repository.prepareCommit(author()));
			expectOk(await f.repository.files.delete('p.txt', local));
			const remote = existed ? 'a\nline2\n' : 'line2\n';
			await f.server.commit(new Map([['p.txt', remote]]));
			expectOk(await f.sync.run());
			expect(await f.server.git(['show', 'main:p.txt'])).toBe(remote);
		} finally {
			await f.close();
		}
	}, 20000);

test('undoing an added child does not resurrect its folder over an incoming file replacement', async () => {
	const f = await fixture();
	try {
		await f.server.commit(new Map([['folder/x.txt', 'old']]));
		expectOk(await f.sync.run());
		expectOk(await f.repository.files.write('folder/new.txt', null, 'local'));
		expectOk(await f.repository.prepareCommit(author()));
		expectOk(await f.repository.files.delete('folder/new.txt', 'local'));
		await f.server.commit(
			new Map([
				['folder/x.txt', null],
				['folder', 'remote replacement'],
			]),
		);
		expectOk(await f.sync.run());
		expect(await f.server.git(['show', 'main:folder'])).toBe(
			'remote replacement',
		);
	} finally {
		await f.close();
	}
}, 20000);

test('a newer edit restoring the remote field removes the obsolete override trailer', async () => {
	const f = await fixture(row('a'));
	try {
		expectOk(await f.sync.run());
		let draft = expectOk(await f.repository.tables.notes.get('one'))!;
		draft = expectOk(
			await f.repository.tables.notes.set('one', draft, {
				fields: { title: 'b' },
			}),
		).sent;
		expectOk(await f.repository.prepareCommit(author()));
		expectOk(
			await f.repository.tables.notes.set('one', draft, {
				fields: { title: 'c', extra: 1 },
			}),
		);
		await f.server.commit(new Map([['notes/one.md', row('c')]]));
		expectOk(await f.sync.run());
		expect(
			expectOk(await f.repository.tables.notes.get('one'))!.fields,
		).toEqual({ title: 'c', extra: 1 });
		expect(await f.server.git(['log', '-1', '--format=%B'])).not.toContain(
			'field="title"',
		);
	} finally {
		await f.close();
	}
}, 20000);
