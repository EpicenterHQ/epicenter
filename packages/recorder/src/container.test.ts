/**
 * Reading and repairing the audio files the recorder writes, over real
 * recordings: a second of a 440 Hz tone that Chromium and WebKit each
 * recorded with `MediaRecorder` in pieces of a quarter second
 * (`fixtures/`), as AAC in MP4 and as Opus in WebM.
 *
 * Key behaviors:
 * - A whole recording reads its length, and needs no repair
 * - A recording cut anywhere is repaired to a prefix that is whole: a second
 *   repair cuts nothing, and its length never exceeds the whole one's
 * - A cut on a piece's boundary loses nothing in MP4, whose pieces are whole
 *   fragments; Chromium's WebM pieces end mid-element, so its cut loses the
 *   part-written block
 * - What is not the format, or too little of it to play, is left alone
 */
import { expect, test } from 'bun:test';
import { audioDurationMs, repairAudio } from './container.js';

const fixture = async (name: string) =>
	new Uint8Array(
		await Bun.file(
			new URL(`./fixtures/${name}`, import.meta.url),
		).arrayBuffer(),
	);

/** Each fixture, its length (by ffprobe), and the sizes of the pieces it was handed over in. */
const RECORDINGS = [
	{ name: 'chromium.m4a', ms: 960, pieces: [667, 2395, 1200, 830] },
	{ name: 'webkit.m4a', ms: 1047, pieces: [1829, 1255, 1330, 1750] },
	{ name: 'chromium.webm', ms: 957, pieces: [3060, 4846, 4846, 2913] },
	{ name: 'webkit.webm', ms: 948, pieces: [5652, 6398, 6466, 6286] },
] as const;

const extOf = (name: string) => name.slice(name.lastIndexOf('.') + 1);

for (const { name, ms, pieces } of RECORDINGS) {
	test(`${name}: a whole recording reads its length and needs no repair`, async () => {
		const bytes = await fixture(name);
		expect(Math.abs(audioDurationMs(bytes, extOf(name))! - ms)).toBeLessThan(
			15,
		);
		expect(repairAudio(bytes, extOf(name))).toBeUndefined();
	});

	test(`${name}: cut anywhere, it is repaired to a whole prefix no longer than the recording`, async () => {
		const bytes = await fixture(name);
		const ext = extOf(name);
		const full = audioDurationMs(bytes, ext)!;
		let previous = 0;
		for (let cut = pieces[0]; cut < bytes.length; cut += 61) {
			const cutOff = bytes.slice(0, cut);
			const repaired = repairAudio(cutOff, ext) ?? cutOff;
			expect(repaired.length).toBeLessThanOrEqual(cut);
			expect(repairAudio(repaired, ext)).toBeUndefined();
			const length = audioDurationMs(repaired, ext)!;
			expect(length).toBeGreaterThanOrEqual(previous);
			expect(length).toBeLessThanOrEqual(full);
			previous = length;
		}
		expect(previous).toBeGreaterThan(full / 2);
	});

	test(`${name}: cut where a piece ended, what each piece held is kept`, async () => {
		const bytes = await fixture(name);
		const ext = extOf(name);
		let end = 0;
		for (const piece of pieces.slice(0, -1)) {
			end += piece;
			const cutOff = bytes.slice(0, end);
			const repaired = repairAudio(cutOff, ext);
			if (ext === 'm4a') expect(repaired).toBeUndefined();
			else expect((repaired ?? cutOff).length).toBeGreaterThan(end - 1200);
		}
	});
}

test('a WebM cut inside a known-size cluster says its size is unknown, so nothing else moves', async () => {
	// One cluster of known size holding two blocks; the cut falls in the second.
	const block = (time: number) => [0xa3, 0x85, 0x81, 0x00, time, 0x80, 0x01];
	const cluster = [0xe7, 0x81, 0x00, ...block(0), ...block(20)];
	const bytes = new Uint8Array([
		...[0x1a, 0x45, 0xdf, 0xa3, 0x80],
		...[0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
		...[0x1f, 0x43, 0xb6, 0x75, 0x80 | cluster.length, ...cluster],
	]);
	expect(audioDurationMs(bytes, 'webm')).toBe(40);
	const cut = bytes.slice(0, bytes.length - 3);
	const repaired = repairAudio(cut, 'webm')!;
	expect(repaired.length).toBe(bytes.length - 7);
	// The cluster's one-byte size is now 0xff: unknown.
	expect(repaired[17 + 4]).toBe(0xff);
	expect(repairAudio(repaired, 'webm')).toBeUndefined();
	expect(audioDurationMs(repaired, 'webm')).toBe(0);
});

test('a WAV reads its length from its header; it is never repaired here', () => {
	const wav = new Uint8Array(44 + 32_000);
	const view = new DataView(wav.buffer);
	const text = (offset: number, value: string) => {
		for (let index = 0; index < value.length; index++)
			view.setUint8(offset + index, value.charCodeAt(index));
	};
	text(0, 'RIFF');
	text(8, 'WAVE');
	text(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint32(28, 32_000, true);
	text(36, 'data');
	view.setUint32(40, 32_000, true);
	expect(audioDurationMs(wav, 'wav')).toBe(1000);
	expect(audioDurationMs(wav.slice(0, 44 + 16_000), 'WAV')).toBe(500);
	expect(repairAudio(wav, 'wav')).toBeUndefined();
});

test('what is not the format, or too little of it to play, is left alone', async () => {
	const m4a = await fixture('chromium.m4a');
	const webm = await fixture('chromium.webm');
	for (const [bytes, ext] of [
		[new Uint8Array([1, 2, 3]), 'm4a'],
		[new Uint8Array([1, 2, 3]), 'webm'],
		[m4a.slice(0, 200), 'm4a'],
		[webm.slice(0, 20), 'webm'],
		[webm, 'm4a'],
		[m4a, 'webm'],
		[m4a, 'mp3'],
	] as const) {
		expect(repairAudio(bytes, ext)).toBeUndefined();
		expect(audioDurationMs(bytes, ext)).toBeUndefined();
	}
});
