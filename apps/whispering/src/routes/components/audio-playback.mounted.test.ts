/**
 * Playback waits for the capture owner to finalize its file in every view.
 * Native-like captures expose unfinished bytes immediately; a held Stop
 * verifies that clicking Stop alone cannot make them playable. Other saved
 * recordings remain playable, and the first playback read sees final bytes.
 */
import '../svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import type { WhisperingServices } from '../../lib/platform/types.js';

const { mount, unmount, flushSync } = await import('svelte');
const { createFixtureDevice, toneWav } = await import('../../lib/capture.js');
const { createTestWhispering, closeTestWhispering } = await import(
	'../../lib/whispering.test-support.js'
);
const { openTestServices, deferred, eventually } = await import(
	'../../lib/services.test-support.js'
);
const { quiet } = await import('../../lib/query.test-support.js');
const Host = (await import('./test-fixtures/AudioPlaybackHost.svelte')).default;

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	document.body.replaceChildren();
});

for (const view of ['home', 'detail', 'file'] as const) {
	test(`${view} shows capture progress until Stop finishes, then reads only finalized audio`, async () => {
		const app = await open(view === 'home');
		const { whispering, context } = app;
		await whispering.startRecording();
		await whispering.readAgain();
		const entry = whispering.entries[0]!;
		const path = entry.path.replace(/\.md$/, '.wav');
		if (view !== 'home') whispering.open(view === 'detail' ? entry.path : path);
		flushSync();
		await quiet(context);
		flushSync();

		expect(app.target.querySelector('audio') === null).toBe(true);
		expect(app.target.textContent).toContain('Recording…');
		expect(app.reads).toEqual([]);
		if (view === 'file') expect(context.folder.files.edit(path).getBuffer().status).toBe('unread');
		if (view !== 'file')
			expect(
				app.target.querySelector<HTMLButtonElement>(
					'[data-testid^="transcribe"]',
				)?.disabled,
			).toBe(true);
		const stopping = whispering.stopRecording();
		flushSync();
		expect(app.target.textContent).toContain('Stopping…');
		expect(app.target.querySelector('audio') === null).toBe(true);
		expect(app.reads).toEqual([]);
		if (view === 'file') expect(context.folder.files.edit(path).getBuffer().status).toBe('unread');
		if (view !== 'file')
			expect(
				app.target.querySelector<HTMLButtonElement>(
					'[data-testid^="transcribe"]',
				)?.disabled,
			).toBe(true);

		app.finish.resolve();
		await stopping;
		await eventually(() => {
			flushSync();
			return app.target.querySelector('audio') !== null;
		});
		expect(app.reads.length).toBeGreaterThan(0);
		expect(app.reads.every((size) => size === toneWav().byteLength)).toBe(true);
		expect(app.target.textContent).not.toContain('Stopping…');
		if (view !== 'file')
			expect(
				app.target.querySelector<HTMLButtonElement>(
					'[data-testid^="transcribe"]',
				)?.disabled,
			).toBe(false);
	});
}

test('a completed recording stays playable while a different recording is active', async () => {
	const app = await open(false);
	const { whispering } = app;
	await whispering.startRecording();
	app.finish.resolve();
	await whispering.stopRecording();
	await whispering.readAgain();
	const first = whispering.entries[0]!;
	whispering.open(first.path);
	await eventually(() => {
		flushSync();
		return app.target.querySelector('audio') !== null;
	});
	const player = app.target.querySelector('audio');
	await whispering.startRecording();
	flushSync();
	expect(whispering.recorder.phase).toBe('recording');
	expect(app.target.querySelector('audio') === player).toBe(true);
});

async function open(home: boolean) {
	const stubs = await openTestServices();
	const finish = deferred<void>();
	const capture = createFixtureDevice({
		name: 'tone.wav',
		load: async () => {
			await finish.promise;
			return { name: 'tone.wav', bytes: toneWav() };
		},
	});
	const services: WhisperingServices = {
		...stubs.services,
		capture: {
			...capture,
			async start(options) {
				const result = await capture.start(options);
				const active = expectOk(result);
				// Native capture creates its destination before finalizing its WAV.
				expectOk(
					await options.folder.write(
						active.audioPath,
						null,
						toneWav().slice(0, 44),
					),
				);
				return result;
			},
		},
	};
	const reads: number[] = [];
	const read = stubs.folder.files.read;
	stubs.folder.files.read = async (path) => {
		const result = await read(path);
		if (
			path.endsWith('.wav') &&
			result.error === null &&
			result.data !== undefined
		)
			reads.push(result.data.content.size);
		return result;
	};
	const { whispering, context } = await createTestWhispering({
		...stubs,
		services,
	});
	await whispering.start();
	const target = document.createElement('main');
	document.body.append(target);
	const host = mount(Host, { target, props: { whispering, context, home } });
	cleanups.push(async () => {
		finish.resolve();
		await unmount(host);
		await closeTestWhispering({ whispering, context });
		await stubs.remove();
	});
	return { whispering, context, target, finish, reads };
}
