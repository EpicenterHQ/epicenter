/**
 * The size cap on a hosted repository's in-memory copy (ADR-0550): the disk
 * store serves a real repository, and a wrapper pads its upload-pack response
 * with side-band progress packets, which the client reads and discards, so
 * the fetch is exactly as large as each case needs. One more repository
 * holds a blob past the limit, so the overflow lands inside real pack data.
 * Requires git on PATH.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiskGitHost, repositoryPath } from './git-disk-store.js';
import {
	MAX_FETCH_BYTES,
	openHostedRepository,
	RepositoryOpenError,
} from './hosted-repository.js';
import type { GitHost } from './routes/git.js';

const ID = 'aaaaaaaaaaaaaaaa';
const LARGE_ID = 'bbbbbbbbbbbbbbbb';
let scratch: string;
let host: GitHost;

function run(cwd: string, ...args: string[]) {
	const result = Bun.spawnSync(
		['git', '-c', 'core.hooksPath=/dev/null', ...args],
		{
			cwd,
			env: {
				PATH: process.env.PATH,
				HOME: cwd,
				GIT_CONFIG_NOSYSTEM: '1',
				GIT_CONFIG_GLOBAL: '/dev/null',
				GIT_AUTHOR_NAME: 'Ada',
				GIT_AUTHOR_EMAIL: 'ada@example.test',
				GIT_COMMITTER_NAME: 'Ada',
				GIT_COMMITTER_EMAIL: 'ada@example.test',
			},
		},
	);
	if (result.exitCode !== 0)
		throw new Error(`git ${args[0]}: ${result.stderr.toString()}`);
}

beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), 'epicenter-hosted-repository-'));
	const store = join(scratch, 'store');
	host = createDiskGitHost({ root: store });
	await host.create(ID);
	const work = join(scratch, 'work');
	run(scratch, 'init', '--quiet', '--initial-branch=main', work);
	await writeFile(join(work, 'note.md'), 'hello\n');
	run(work, 'add', 'note.md');
	run(work, 'commit', '--quiet', '-m', 'first');
	run(work, 'push', '--quiet', repositoryPath(store, ID), 'main');

	// Random bytes do not compress, so the pack is larger than the limit.
	await host.create(LARGE_ID);
	const large = join(scratch, 'large');
	run(scratch, 'init', '--quiet', '--initial-branch=main', large);
	await writeFile(
		join(large, 'take.wav'),
		randomBytes(MAX_FETCH_BYTES + 1024 * 1024),
	);
	run(large, 'add', 'take.wav');
	run(large, 'commit', '--quiet', '-m', 'a recording');
	run(large, 'push', '--quiet', repositoryPath(store, LARGE_ID), 'main');
});

afterAll(async () => {
	await rm(scratch, { recursive: true, force: true });
});

function pkt(payload: Uint8Array) {
	const line = new Uint8Array(payload.byteLength + 4);
	line.set(
		new TextEncoder().encode(
			(payload.byteLength + 4).toString(16).padStart(4, '0'),
		),
	);
	line.set(payload, 4);
	return line;
}

/** Side-band progress packets (channel 2) totalling exactly `bytes`. */
function progress(bytes: number): Uint8Array[] {
	const packets: Uint8Array[] = [];
	let remaining = bytes;
	while (remaining > 0) {
		// A packet is 6 to 65520 bytes; never leave a remainder under 6.
		let size = Math.min(remaining, 65520);
		if (remaining - size > 0 && remaining - size < 6) size -= 6;
		const payload = new Uint8Array(size - 4).fill(0x2e);
		payload[0] = 2;
		packets.push(pkt(payload));
		remaining -= size;
	}
	return packets;
}

/** `host`, with each upload-pack response padded after its `NAK` to `total` bytes. */
function paddedTo(total: number): GitHost & { served: () => number } {
	let served = 0;
	return {
		served: () => served,
		create: (id) => host.create(id),
		delete: (id) => host.delete(id),
		async serve(id, request) {
			const response = await host.serve(id, request);
			if (request.advertisement || request.service !== 'git-upload-pack')
				return response;
			const real = new Uint8Array(await response.arrayBuffer());
			const nak = new TextEncoder().encode('0008NAK\n');
			expect(real.subarray(0, nak.byteLength)).toEqual(nak);
			const parts = [
				nak,
				...progress(total - real.byteLength),
				real.subarray(nak.byteLength),
			];
			return new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						const next = parts.shift();
						if (next === undefined) return controller.close();
						served += next.byteLength;
						controller.enqueue(next);
					},
				}),
				{ headers: response.headers },
			);
		},
	};
}

function open(store: GitHost, repositoryId = ID) {
	return openHostedRepository(store, {
		repositoryId,
		accountId: 'account',
		signal: new AbortController().signal,
	});
}

test('a repository under the limit opens and reads', async () => {
	const { data, error } = await open(host);
	expect(error).toBeNull();
	expect(await data?.readFiles(['note.md'])).toEqual([
		{ path: 'note.md', content: 'hello\n' },
	]);
});

test('a fetch of exactly the limit opens and reads', async () => {
	const store = paddedTo(MAX_FETCH_BYTES);
	const { data, error } = await open(store);
	expect(error).toBeNull();
	expect(store.served()).toBe(MAX_FETCH_BYTES);
	expect(await data?.readFiles(['note.md'])).toEqual([
		{ path: 'note.md', content: 'hello\n' },
	]);
});

test('a fetch one byte over the limit is refused as TooLarge', async () => {
	const store = paddedTo(MAX_FETCH_BYTES + 1);
	const { data, error } = await open(store);
	expect(data).toBeNull();
	expect(error).toEqual(
		RepositoryOpenError.TooLarge({ bytes: MAX_FETCH_BYTES }).error,
	);
	expect(error?.message).toContain('(8 MiB)');
});

test('a pack whose own data passes the limit is refused as TooLarge', async () => {
	const { data, error } = await open(host, LARGE_ID);
	expect(data).toBeNull();
	expect(error?.name).toBe('TooLarge');
});
