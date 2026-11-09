/**
 * Reading how long the audio files a recorder writes play, over real
 * recordings: a second of a 440 Hz tone that Chromium and WebKit each
 * recorded with `MediaRecorder` (`fixtures/`), as AAC in MP4 and as Opus in
 * WebM, and one the desktop's recorder encoded (`desktop.webm`).
 *
 * Key behaviors:
 * - A recording reads its length; the desktop's reads the Duration it states
 * - A WAV reads its length from its header
 * - What is not the format, or too little of it to play, reads no length
 */
import { expect, test } from 'bun:test';
import { audioDurationMs } from './container.js';

const fixture = async (name: string) =>
	new Uint8Array(
		await Bun.file(
			new URL(`./fixtures/${name}`, import.meta.url),
		).arrayBuffer(),
	);

/**
 * Each fixture and its play length: ffprobe's, less the 2112 samples of AAC
 * priming WebKit's edit list skips (`afinfo`: 1.001 s); Chromium's MP4 has
 * no edit list.
 */
const RECORDINGS = [
	{ name: 'chromium.m4a', ms: 960 },
	{ name: 'webkit.m4a', ms: 1001 },
	{ name: 'chromium.webm', ms: 957 },
	{ name: 'webkit.webm', ms: 948 },
] as const;

const extOf = (name: string) => name.slice(name.lastIndexOf('.') + 1);

for (const { name, ms } of RECORDINGS)
	test(`${name}: a recording reads its length`, async () => {
		const bytes = await fixture(name);
		expect(Math.abs(audioDurationMs(bytes, extOf(name))! - ms)).toBeLessThan(
			15,
		);
	});

test('a WebM reads its length from its last blocks when it states none', () => {
	const block = (time: number) => [0xa3, 0x85, 0x81, 0x00, time, 0x80, 0x01];
	const cluster = [0xe7, 0x81, 0x00, ...block(0), ...block(20)];
	const bytes = new Uint8Array([
		...[0x1a, 0x45, 0xdf, 0xa3, 0x80],
		...[0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
		...[0x1f, 0x43, 0xb6, 0x75, 0x80 | cluster.length, ...cluster],
	]);
	expect(audioDurationMs(bytes, 'webm')).toBe(40);
});

test('a desktop recording reads the length its Duration states, to the sample', async () => {
	// 16,007 samples at 16 kHz, encoded by the desktop's recorder: 1000.4375 ms
	// play. Its last block starts at 1,000 ms; reading the length from the
	// blocks would answer 1,020.
	const bytes = await fixture('desktop.webm');
	expect(audioDurationMs(bytes, 'webm')).toBe(1000);
});

test('a WAV reads its length from its header', () => {
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
});

test('what is not the format, or too little of it to play, reads no length', async () => {
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
	] as const)
		expect(audioDurationMs(bytes, ext)).toBeUndefined();
});
