/**
 * Current downloads preserve one immutable capture and reject incomplete wire
 * coverage, invalid metadata, and the former snapshot-only response format.
 */
import { expect, test } from 'bun:test';
import {
	createCurrentDownloadResponse,
	readCurrentDownload,
} from './current-download.js';

function capture() {
	return {
		generation: 3,
		head: 5,
		snapshot: { position: 3, bytes: new Uint8Array([1, 2]) },
		tail: [
			{ seq: 4, bytes: new Uint8Array([3]) },
			{ seq: 5, bytes: new Uint8Array([4, 5]) },
		],
	};
}

test('a response owns its captured bytes and positions before its source changes', async () => {
	const source = capture();
	const expected = structuredClone(source);
	const response = createCurrentDownloadResponse(source);
	source.snapshot.bytes.fill(9);
	for (const entry of source.tail) entry.bytes.fill(9);
	source.head = 6;
	source.generation = 4;
	expect(await readCurrentDownload(response)).toEqual(expected);
});

test('positions above the socket u32 range remain exact in an HTTP capture', async () => {
	const position = Number.MAX_SAFE_INTEGER - 1;
	const source = {
		generation: Number.MAX_SAFE_INTEGER,
		head: position + 1,
		snapshot: { position, bytes: new Uint8Array([1]) },
		tail: [{ seq: position + 1, bytes: new Uint8Array([2]) }],
	};
	expect(
		await readCurrentDownload(createCurrentDownloadResponse(source)),
	).toEqual(source);
});

test('omitted, truncated, and extra update bytes cannot claim a complete capture', async () => {
	const response = createCurrentDownloadResponse(capture());
	const body = new Uint8Array(await response.arrayBuffer());
	for (const changed of [
		body.slice(0, -6),
		body.slice(0, -1),
		new Uint8Array([...body, 0]),
	]) {
		await expect(
			readCurrentDownload(new Response(changed, { headers: response.headers })),
		).rejects.toThrow('Current data download');
	}
});

test('invalid generation, head, version, and raw snapshot responses fail closed', async () => {
	for (const [header, value] of [
		['epicenter-generation', '0'],
		['epicenter-generation', '9007199254740992'],
		['epicenter-log-position', '2'],
		['epicenter-log-position', '6'],
	] as const) {
		const response = createCurrentDownloadResponse(capture());
		response.headers.set(header, value);
		await expect(readCurrentDownload(response)).rejects.toThrow();
	}
	const response = createCurrentDownloadResponse(capture());
	const body = new Uint8Array(await response.arrayBuffer());
	body[4] = 2;
	await expect(
		readCurrentDownload(new Response(body, { headers: response.headers })),
	).rejects.toThrow('invalid format');
	await expect(
		readCurrentDownload(
			new Response(new Uint8Array([1]), {
				headers: {
					'content-type': 'application/octet-stream',
					'epicenter-generation': '1',
					'epicenter-log-position': '1',
				},
			}),
		),
	).rejects.toThrow('unsupported content type');
});

test('the response producer refuses a capture with missing or reordered log positions', () => {
	const source = capture();
	expect(() =>
		createCurrentDownloadResponse({ ...source, tail: source.tail.slice(1) }),
	).toThrow('captured head');
	expect(() =>
		createCurrentDownloadResponse({
			...source,
			tail: source.tail.toReversed(),
		}),
	).toThrow('log gap');
});
