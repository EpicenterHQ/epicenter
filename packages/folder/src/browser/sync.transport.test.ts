/**
 * Native wire regressions for shallow negotiation, actual delta packs, recovery
 * of missing ancestry, and a fetched snapshot resumed after another tab advanced.
 */
import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createGitServer } from '../../smoke/git-server.js';
import type { HttpRequest } from './git/transfer.js';
import { openRepository } from './repository.js';
import { createSync } from './sync.js';

const author = () => ({
	name: 'Wire',
	email: 'wire@example.com',
	timestamp: 1,
});
const encoder = new TextEncoder(),
	decoder = new TextDecoder();

function packBytes(response: Uint8Array) {
	const parts: Uint8Array[] = [];
	for (let offset = 0; offset + 4 <= response.length; ) {
		const length = Number.parseInt(
			decoder.decode(response.subarray(offset, offset + 4)),
			16,
		);
		if (!Number.isFinite(length)) throw new Error('Non pkt-line response');
		if (length === 0) {
			offset += 4;
			continue;
		}
		if (length < 4 || offset + length > response.length)
			throw new Error('Truncated pkt-line response');
		const data = response.subarray(offset + 4, offset + length);
		if (data[0] === 1) parts.push(data.subarray(1));
		offset += length;
	}
	const result = new Uint8Array(
		parts.reduce((size, part) => size + part.length, 0),
	);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}

test('actual incoming deltas inflate and an ordinary shallow push passes native fsck', async () => {
	const server = await createGitServer();
	const repository = await openRepository(crypto.randomUUID());
	try {
		await server.commit(
			new Map(
				Array.from({ length: 40 }, (_, i) => [
					`files/${i}.txt`,
					`${'shared content line\n'.repeat(500)}unique ${i}\n`,
				]),
			),
		);
		await server.commit(new Map([['history.txt', 'second commit']]));
		await server.git(['repack', '-adf', '--depth=50', '--window=50']);
		const responses: Uint8Array[] = [];
		const requests: string[] = [];
		const request: HttpRequest = async (input, init) => {
			const response = await fetch(input, init);
			if (
				init?.method === 'POST' &&
				String(input).endsWith('/git-upload-pack')
			) {
				requests.push(decoder.decode(init.body as Uint8Array));
				responses.push(new Uint8Array(await response.clone().arrayBuffer()));
			}
			return response;
		};
		const sync = createSync(repository, { url: server.url, author, request });
		expectOk(await sync.run());
		const pack = packBytes(responses[0]!);
		expect(decoder.decode(pack.subarray(0, 4))).toBe('PACK');
		const indexed = await server.git(
			['index-pack', '--stdin', '--fix-thin'],
			pack,
		);
		const packId = indexed.match(/[0-9a-f]{40}/)![0];
		const verified = await server.git([
			'verify-pack',
			'-v',
			join(server.directory, 'objects/pack', `pack-${packId}.idx`),
		]);
		const deltas = verified
			.split('\n')
			.filter(
				(line) =>
					line.trim().split(/\s+/).length === 7 && /^[0-9a-f]{40} /.test(line),
			);
		expect(deltas.length).toBeGreaterThan(0);
		const base = (await repository.storage.capture('sync')).state.remoteBase!;
		expect(requests[0]).toContain('deepen 1');
		expectOk(
			await repository.files.write(
				'files/0.txt',
				`${'shared content line\n'.repeat(500)}unique 0\n`,
				'Edited from shallow client\n',
			),
		);
		expectOk(await sync.run());
		expect(requests[1]).toContain(`have ${base}`);
		expect(requests[1]).toContain(`shallow ${base}`);
		expect(requests[1]).not.toContain('deepen');
		expect(await server.git(['show', 'main:files/0.txt'])).toBe(
			'Edited from shallow client\n',
		);
		await server.git(['fsck', '--strict']);
	} finally {
		repository.close();
		await server.close();
	}
}, 20000);

test('a fetched snapshot held while another tab advances cannot rewind its newer base', async () => {
	const server = await createGitServer();
	const id = crypto.randomUUID(),
		a = await openRepository(id),
		b = await openRepository(id);
	const release = Promise.withResolvers<void>();
	try {
		await server.commit(new Map([['file.txt', 'one']]));
		expectOk(await createSync(a, { url: server.url, author }).run());
		await server.commit(new Map([['file.txt', 'two']]));
		const held = Promise.withResolvers<void>();
		const request: HttpRequest = async (input, init) => {
			const response = await fetch(input, init);
			if (
				init?.method === 'POST' &&
				String(input).endsWith('/git-upload-pack')
			) {
				const bytes = await response.arrayBuffer();
				held.resolve();
				await release.promise;
				return new Response(bytes, {
					status: response.status,
					headers: response.headers,
				});
			}
			return response;
		};
		const old = createSync(a, { url: server.url, author, request }).run();
		await held.promise;
		const fresh = createSync(b, { url: server.url, author });
		expectOk(await fresh.run());
		const newest = await server.commit(new Map([['file.txt', 'three']]));
		expectOk(await fresh.run());
		release.resolve();
		expect(expectOk(await old).outcome).toBe('pending');
		expect((await a.storage.capture()).state.remoteBase).toBe(newest);
		expect(await expectOk(await a.files.read('file.txt'))!.content.text()).toBe(
			'three',
		);
	} finally {
		release.resolve();
		a.close();
		b.close();
		await server.close();
	}
}, 20000);

for (const incompleteRecovery of [false, true])
	test(`a shallow ancestry gap ${incompleteRecovery ? 'preserves pending work when recovery is still incomplete' : 'uses a separate full recovery fetch'}`, async () => {
		const server = await createGitServer();
		const repository = await openRepository(crypto.randomUUID());
		try {
			await server.commit(new Map([['row.md', '---\ntitle: Base\n---\n']]));
			expectOk(await createSync(repository, { url: server.url, author }).run());
			expectOk(
				await repository.files.write(
					'row.md',
					'---\ntitle: Base\n---\n',
					'---\ntitle: Local\n---\n',
				),
			);
			expectOk(await repository.prepareCommit(author()));
			expectOk(await repository.files.write('newer.txt', null, 'newer'));
			await server.commit(new Map([['middle.txt', 'middle']]));
			await server.commit(new Map([['row.md', '---\ntitle: Remote\n---\n']]));
			const before = await repository.storage.capture('sync');
			const wire: string[] = [];
			const request: HttpRequest = async (input, init) => {
				if (
					init?.method === 'POST' &&
					String(input).endsWith('/git-upload-pack')
				) {
					let body = decoder.decode(init.body as Uint8Array);
					wire.push(body);
					if (incompleteRecovery || wire.length === 1) {
						const data = 'deepen 1\n';
						const packet = `${(data.length + 4).toString(16).padStart(4, '0')}${data}`;
						let offset = 0;
						while (body.slice(offset, offset + 4) !== '0000') {
							const length = Number.parseInt(
								body.slice(offset, offset + 4),
								16,
							);
							if (!Number.isFinite(length) || length < 4)
								throw new Error('Malformed fetch request');
							offset += length;
						}
						body = body.slice(0, offset) + packet + body.slice(offset);
						return fetch(input, { ...init, body: encoder.encode(body) });
					}
				}
				return fetch(input, init);
			};
			const result = await createSync(repository, {
				url: server.url,
				author,
				request,
			}).run();
			expect(wire).toHaveLength(2);
			expect(wire[0]).toContain('have ');
			expect(wire[1]).not.toContain('have ');
			if (incompleteRecovery) {
				expect(expectErr(result).name).toBe('UnknownAncestry');
				const after = await repository.storage.capture('sync');
				expect(after.state).toEqual(before.state);
				expect(after.edits).toEqual(before.edits);
			} else {
				expectOk(result);
				expect(await server.git(['show', 'main:row.md'])).toContain(
					'title: Local',
				);
				expect(await server.git(['show', 'main:newer.txt'])).toBe('newer');
				await server.git(['fsck', '--strict']);
			}
		} finally {
			repository.close();
			await server.close();
		}
	}, 20000);
