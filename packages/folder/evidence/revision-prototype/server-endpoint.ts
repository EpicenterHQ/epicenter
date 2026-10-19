/**
 * THROWAWAY: local-only service-side commit probe. Native bare Git, one file,
 * exact request retries, overlapping requests, and existing content merge.
 * This is not an Artifacts/Worker or browser protocol implementation.
 */
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { merge } from '../../src/merge-file.js';

const root = await mkdtemp(join(tmpdir(), 'epicenter-endpoint-PROTOTYPE-'));
const env = { ...process.env, GIT_AUTHOR_NAME: 'Prototype', GIT_AUTHOR_EMAIL: 'prototype@example.invalid', GIT_COMMITTER_NAME: 'Prototype', GIT_COMMITTER_EMAIL: 'prototype@example.invalid', GIT_AUTHOR_DATE: '2000-01-01T00:00:00 +0000', GIT_COMMITTER_DATE: '2000-01-01T00:00:00 +0000' };
function git(args: string[], input?: string, allowFailure = false) {
	const result = Bun.spawnSync(['git', '--git-dir', root, ...args], { env, ...(input === undefined ? {} : { stdin: new TextEncoder().encode(input) }) });
	if (result.exitCode && !allowFailure) throw Error(result.stderr.toString());
	return { status: result.exitCode, text: result.stdout.toString().trim() };
}
git(['init', '--bare', '--initial-branch=main', root]);
function commit(text: string, parents: string[], message: string) {
	const blob = git(['hash-object', '-w', '--stdin'], text).text;
	const tree = git(['mktree'], `100644 blob ${blob}\tnote.md\n`).text;
	return git(['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent])], message + '\n').text;
}
function read(oid: string) { return git(['show', `${oid}:note.md`]).text + '\n'; }
const initial = '---\ntitle: original\n---\nFirst paragraph.\n\nSecond paragraph.\n';
const B = commit(initial, [], 'initial'); git(['update-ref', 'refs/heads/main', B]);
let casRetries = 0;
let notifyPublished: (() => void) | undefined;
const published = new Promise<void>((resolve) => { notifyPublished = resolve; });
type Outbox = { base: string; text: string; id: string };
async function apply(outbox: Outbox) {
	const L = commit(outbox.text, [outbox.base], `request ${outbox.id}`);
	for (let attempt = 0; attempt < 20; attempt++) {
		const H = git(['rev-parse', 'refs/heads/main']).text;
		if (git(['merge-base', '--is-ancestor', L, H], undefined, true).status === 0) return { accepted: L, head: H, duplicate: true, text: read(H) };
		const result = await merge('note.md', { base: read(outbox.base), ours: outbox.text, theirs: read(H) });
		if (typeof result.content !== 'string') throw Error('expected merged text');
		const next = H === outbox.base ? L : commit(result.content, [H, L], `accept ${outbox.id}`);
		await Bun.sleep(20); // Force overlapping requests to exercise the Git ref compare-and-swap.
		if (git(['update-ref', 'refs/heads/main', next, H], undefined, true).status === 0) return { accepted: L, head: next, duplicate: false, text: read(next) };
		casRetries++;
	}
	throw Error('CAS did not converge');
}
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
	const result = await apply(await request.json() as Outbox);
	if (new URL(request.url).searchParams.has('delay-reply')) { notifyPublished?.(); await Bun.sleep(250); }
	return Response.json(result);
} });
async function send(outbox: Outbox) { return await (await fetch(server.url, { method: 'POST', body: JSON.stringify(outbox) })).json() as Awaited<ReturnType<typeof apply>>; }
try {
	const outbox = { base: B, text: initial.replace('title: original', 'title: phone'), id: 'phone-1' };
	const controller = new AbortController();
	const pending = fetch(new URL('?delay-reply', server.url), { method: 'POST', body: JSON.stringify(outbox), signal: controller.signal }).then(() => 'unexpected reply', () => 'reply unavailable');
	await published; controller.abort(); const lostReply = await pending;
	const accepted = git(['rev-parse', 'refs/heads/main']).text;
	const desktop = commit(read(accepted).replace('title: phone', 'title: desktop'), [accepted], 'ordinary native desktop commit');
	git(['update-ref', 'refs/heads/main', desktop, accepted]);
	const retried = await send(outbox);
	const stableRequestPreservedDesktop = retried.duplicate && retried.head === desktop && retried.text.includes('title: desktop');
	// A new identity with the same stale payload is a different edit and replays it.
	const replay = await send({ ...outbox, id: 'incorrectly-recreated-request' });
	const recreatedRequestReplayed = replay.text.includes('title: phone');
	const sharedBase = replay.head;
	const source = read(sharedBase);
	const [a, b] = await Promise.all([
		send({ base: sharedBase, text: source.replace('title: phone', 'title: concurrent-A'), id: 'concurrent-A' }),
		send({ base: sharedBase, text: source.replace('Second paragraph.', 'Independent paragraph from B.'), id: 'concurrent-B' }),
	]);
	const finalHead = git(['rev-parse', 'refs/heads/main']).text;
	const finalText = read(finalHead);
	const independentEditsSurvived = finalText.includes('title: concurrent-A') && finalText.includes('Independent paragraph from B.');
	const fsck = git(['fsck', '--full']);
	const result = { scope: 'One-file, local native bare Git service probe; not Worker, Artifacts, auth, complete protocol, or browser adoption', root, lostReply, stableRequestPreservedDesktop, recreatedRequestReplayed, independentEditsSurvived, casRetries, fsckStatus: fsck.status, accepted, desktop, retried, replay, concurrent: [a, b], finalHead, finalText };
	if (!stableRequestPreservedDesktop || !recreatedRequestReplayed || !independentEditsSurvived || !casRetries || fsck.status) throw Error('endpoint probe failed');
	await mkdir('/tmp/epicenter-revision-endpoint', { recursive: true });
	await Bun.write('/tmp/epicenter-revision-endpoint/results.json', JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result, null, 2));
} finally { server.stop(true); }
