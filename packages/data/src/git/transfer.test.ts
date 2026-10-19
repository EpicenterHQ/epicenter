/**
 * Git Transfer Tests
 *
 * Runs fetchRemote and pushRemote against a scripted smart-HTTP remote
 * (`transfer.test-support.ts`) so the contract with a caller that holds only
 * inflated objects can be checked without a server. What a real native
 * server does with these requests is checked separately.
 *
 * Key behaviors:
 * - an initial fetch asks for one commit; a later one declares B's boundary
 *   shallow and is answered with only what B lacked
 * - every new commit's trees and blobs come back, gitlinks are not followed,
 *   and a pack missing something the new commit needs is a transfer failure
 * - recover ignores the retained commits and returns whole history
 * - a remote with no `main` fetches as head null, while HTTP errors, dropped
 *   connections and aborts throw instead of looking empty
 * - a push checks `main` against the base in the same advertisement it
 *   pushes from, and sends nothing when that check fails or the head is there
 * - a definitive non-fast-forward rejects, every other uncertainty throws, and
 *   history too short to show fast-forwardness is not a rejection
 */

import { describe, expect, test } from 'bun:test';
import { fetchRemote, pushRemote, TransferFailure } from './transfer.js';
import {
	dropped,
	history,
	packOf,
	receivePackReply,
	remote,
	uploadPackReply,
	ZERO,
} from './transfer.test-support.js';

const URL = 'https://git.example.com/user/repo.git';

describe('fetchRemote', () => {
	test('an initial fetch takes the tip alone and marks it shallow', async () => {
		const h = await history();
		const wanted = [...h.added.c3, h.d2, h.b2];
		const pack = await packOf(h.objects, wanted);
		const answering = remote({
			refs: [
				['HEAD', h.c3],
				['refs/heads/main', h.c3],
			],
			post: () => uploadPackReply({ shallow: [h.c3], pack }),
		});

		const result = await fetchRemote({
			url: URL,
			input: {
				objects: new Map(),
				refs: { base: null, head: null, shallow: [] },
			},
			initial: true,
			request: answering.request,
		});

		expect(result.head).toBe(h.c3);
		expect([...result.objects.keys()].sort()).toEqual([...wanted].sort());
		for (const [oid, object] of result.objects) {
			expect(object).toEqual(h.objects.get(oid)!);
		}
		expect(result.shallow).toEqual([h.c3]);
		expect(answering.posts()[0]!.body).toContain('deepen 1');
	});

	test('a later fetch is negotiated from B and returns only what B lacked', async () => {
		const h = await history();
		const wanted = [...h.added.c2, ...h.added.c3];
		const pack = await packOf(h.objects, wanted);
		const server = remote({
			refs: [
				['HEAD', h.c3],
				['refs/heads/main', h.c3],
			],
			post: () => uploadPackReply({ pack }),
		});

		const result = await fetchRemote({
			url: URL,
			input: {
				objects: h.pick(h.added.c1),
				refs: { base: h.c1, head: h.c1, shallow: [h.c1] },
			},
			initial: false,
			request: server.request,
		});

		expect(result.head).toBe(h.c3);
		expect([...result.objects.keys()].sort()).toEqual([...wanted].sort());
		expect(result.shallow).toEqual([h.c1]);
		const body = server.posts()[0]!.body;
		expect(body).toContain(`have ${h.c1}`);
		expect(body).toContain(`shallow ${h.c1}`);
		expect(body).not.toContain('deepen');
	});

	test('a pack that leaves out something the new commit needs fails', async () => {
		const h = await history();
		const pack = await packOf(h.objects, [h.c3, h.t3, h.d2, h.b2]);
		const server = remote({
			refs: [['refs/heads/main', h.c3]],
			post: () => uploadPackReply({ shallow: [h.c3], pack }),
		});

		await expect(
			fetchRemote({
				url: URL,
				input: {
					objects: new Map(),
					refs: { base: null, head: null, shallow: [] },
				},
				initial: true,
				request: server.request,
			}),
		).rejects.toBeInstanceOf(TransferFailure);
	});

	test('recover asks an empty repository for the whole history', async () => {
		const h = await history();
		const everything = [...h.added.c1, ...h.added.c2, ...h.added.c3];
		const pack = await packOf(h.objects, everything);
		const server = remote({
			refs: [['refs/heads/main', h.c3]],
			post: () => uploadPackReply({ pack }),
		});

		const result = await fetchRemote({
			url: URL,
			input: {
				objects: h.pick(h.added.c1),
				refs: { base: h.c1, head: h.c1, shallow: [h.c1] },
			},
			initial: false,
			recover: true,
			request: server.request,
		});

		expect(result.head).toBe(h.c3);
		expect([...result.objects.keys()].sort()).toEqual([...everything].sort());
		expect(result.shallow).toEqual([]);
		const body = server.posts()[0]!.body;
		expect(body).not.toContain('have ');
		expect(body).not.toMatch(/shallow [0-9a-f]{40}/);
		expect(body).not.toContain('deepen');
	});

	test('a remote with no main fetches as head null without a second request', async () => {
		const h = await history();
		for (const refs of [[], [['refs/heads/dev', h.c1]]] as const) {
			const server = remote({ refs });
			const result = await fetchRemote({
				url: URL,
				input: {
					objects: new Map(),
					refs: { base: null, head: null, shallow: [] },
				},
				initial: true,
				request: server.request,
			});
			expect(result.head).toBeNull();
			expect(result.objects.size).toBe(0);
			expect(server.posts()).toEqual([]);
		}
	});

	test('failures to reach a repository never look like an empty one', async () => {
		const input = {
			objects: new Map(),
			refs: { base: null, head: null, shallow: [] },
		};

		await expect(
			fetchRemote({
				url: URL,
				input,
				initial: true,
				request: remote({ refs: [], unauthorized: true }).request,
			}),
		).rejects.toMatchObject({ name: 'TransferFailure', status: 401 });

		await expect(
			fetchRemote({
				url: URL,
				input,
				initial: true,
				request: (async () => {
					throw new TypeError('Failed to fetch');
				}) as unknown as typeof fetch,
			}),
		).rejects.toBeInstanceOf(TransferFailure);

		const aborted = new AbortController();
		aborted.abort();
		await expect(
			fetchRemote({
				url: URL,
				input,
				initial: true,
				signal: aborted.signal,
				request: remote({ refs: [] }).request,
			}),
		).rejects.toBeInstanceOf(TransferFailure);
	});

	test('a reply that dies mid-stream throws rather than ending the fetch', async () => {
		const h = await history();
		const server = remote({
			refs: [['refs/heads/main', h.c3]],
			post: () => dropped(new TextEncoder().encode('0008NAK\n')),
		});

		await expect(
			fetchRemote({
				url: URL,
				input: {
					objects: new Map(),
					refs: { base: null, head: null, shallow: [] },
				},
				initial: true,
				request: server.request,
			}),
		).rejects.toBeInstanceOf(TransferFailure);
	});
});

describe('pushRemote', () => {
	async function pending() {
		const h = await history();
		return {
			h,
			input: {
				objects: h.pick([...h.added.c1, ...h.added.c2]),
				refs: { base: h.c1, head: h.c2, shallow: [h.c1] },
			},
			ok: () => receivePackReply(['unpack ok', 'ok refs/heads/main']),
		};
	}

	test('pushes head over the advertised base and names that base to the server', async () => {
		const { h, input, ok } = await pending();
		const server = remote({ refs: [['refs/heads/main', h.c1]], post: ok });

		const outcome = await pushRemote({
			url: URL,
			input,
			base: h.c1,
			head: h.c2,
			request: server.request,
		});

		expect(outcome).toBe('pushed');
		expect(server.posts()).toHaveLength(1);
		expect(server.posts()[0]!.body).toContain(
			`${h.c1} ${h.c2} refs/heads/main`,
		);
	});

	test('creates main on a remote that has none', async () => {
		const h = await history();
		const server = remote({
			refs: [],
			post: () => receivePackReply(['unpack ok', 'ok refs/heads/main']),
		});

		const outcome = await pushRemote({
			url: URL,
			input: {
				objects: h.pick(h.added.c1),
				refs: { base: null, head: h.c1, shallow: [] },
			},
			base: null,
			head: h.c1,
			request: server.request,
		});

		expect(outcome).toBe('pushed');
		expect(server.posts()[0]!.body).toContain(
			`${ZERO} ${h.c1} refs/heads/main`,
		);
	});

	test('rejects, sending nothing, when main is not where base says', async () => {
		const { h, input, ok } = await pending();
		for (const refs of [
			[['refs/heads/main', h.c3]],
			[['refs/heads/main', h.unrelated]],
			[['refs/heads/dev', h.c1]],
		] as const) {
			const server = remote({ refs, post: ok });
			const outcome = await pushRemote({
				url: URL,
				input,
				base: h.c1,
				head: h.c2,
				request: server.request,
			});
			expect(outcome).toBe('rejected');
			expect(server.posts()).toEqual([]);
		}
	});

	test('a remote already at head is pushed, sending nothing', async () => {
		const { h, input, ok } = await pending();
		const server = remote({ refs: [['refs/heads/main', h.c2]], post: ok });

		const outcome = await pushRemote({
			url: URL,
			input,
			base: h.c1,
			head: h.c2,
			request: server.request,
		});

		expect(outcome).toBe('pushed');
		expect(server.posts()).toEqual([]);
	});

	test('a server that reports main moved is a rejection', async () => {
		const { h, input } = await pending();
		for (const reason of ['non-fast-forward', 'failed to update ref']) {
			const server = remote({
				refs: [['refs/heads/main', h.c1]],
				post: () =>
					receivePackReply(['unpack ok', `ng refs/heads/main ${reason}`]),
			});
			const outcome = await pushRemote({
				url: URL,
				input,
				base: h.c1,
				head: h.c2,
				request: server.request,
			});
			expect(outcome).toBe('rejected');
		}
	});

	test('a server that declines for another reason throws', async () => {
		const { h, input } = await pending();
		const server = remote({
			refs: [['refs/heads/main', h.c1]],
			post: () =>
				receivePackReply([
					'unpack ok',
					'ng refs/heads/main pre-receive hook declined',
				]),
		});

		await expect(
			pushRemote({
				url: URL,
				input,
				base: h.c1,
				head: h.c2,
				request: server.request,
			}),
		).rejects.toMatchObject({ name: 'TransferFailure', reason: 'declined' });
	});

	test('a reply that never confirms main leaves the outcome thrown, not pushed', async () => {
		const { h, input } = await pending();
		const replies = {
			empty: () => '',
			dropped: () => dropped(new TextEncoder().encode('0000')),
			'no report for main': () => receivePackReply(['unpack ok']),
			'unpack failed': () =>
				receivePackReply([
					'unpack index-pack abnormal exit',
					'ng refs/heads/main unpacker error',
				]),
			'server error': () => new Response('boom', { status: 500 }),
		};
		for (const [name, post] of Object.entries(replies)) {
			const server = remote({ refs: [['refs/heads/main', h.c1]], post });
			const outcome = await pushRemote({
				url: URL,
				input,
				base: h.c1,
				head: h.c2,
				request: server.request,
			}).catch((error: unknown) => error);
			expect(outcome, name).toBeInstanceOf(TransferFailure);
		}
	});

	test('history too short to show a fast-forward throws, it is not a rejection', async () => {
		const h = await history();
		const server = remote({
			refs: [['refs/heads/main', h.c1]],
			post: () => receivePackReply(['unpack ok', 'ok refs/heads/main']),
		});
		const objects = h.pick([...h.added.c3, h.d2, h.b2]);

		for (const shallow of [[h.c3], []]) {
			await expect(
				pushRemote({
					url: URL,
					input: { objects, refs: { base: h.c1, head: h.c3, shallow } },
					base: h.c1,
					head: h.c3,
					request: server.request,
				}),
			).rejects.toMatchObject({
				name: 'TransferFailure',
				reason: 'limited-history',
			});
		}
		expect(server.posts()).toEqual([]);
	});

	test('a head that provably does not descend from base is a rejection', async () => {
		const h = await history();
		const server = remote({
			refs: [['refs/heads/main', h.c1]],
			post: () => receivePackReply(['unpack ok', 'ok refs/heads/main']),
		});

		const outcome = await pushRemote({
			url: URL,
			input: {
				objects: h.pick([...h.added.c1, h.unrelated]),
				refs: { base: h.c1, head: h.unrelated, shallow: [] },
			},
			base: h.c1,
			head: h.unrelated,
			request: server.request,
		});

		expect(outcome).toBe('rejected');
		expect(server.posts()).toEqual([]);
	});

	test('a head the caller did not supply is a defect, not a transfer failure', async () => {
		const { h, input } = await pending();

		const error = await pushRemote({
			url: URL,
			input,
			base: h.c1,
			head: h.c3,
			request: remote({ refs: [] }).request,
		}).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(TransferFailure);
	});
});
