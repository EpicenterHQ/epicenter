/**
 * Playback waits for the capture owner to finalize its file in every view.
 * Native-like captures expose unfinished bytes immediately; a held Stop
 * verifies that clicking Stop alone cannot make them playable. Other saved
 * recordings remain playable, the first playback read sees final bytes, and
 * a player reads again when the folder shows its file changed.
 */
import '../svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import type { WhisperingFolder } from '../../lib/folder.js';
import type { WhisperingServices } from '../../lib/platform/types.js';

const { mount, unmount, flushSync } = await import('svelte');
const { createFixtureDevice, toneWav } = await import('../../lib/capture.js');
const { createTestWhispering, closeTestWhispering } = await import(
	'../../lib/whispering.test-support.js'
);
const { openTestServices, deferred, eventually, waitForSaves } = await import(
	'../../lib/services.test-support.js'
);
const Host = (await import('./test-fixtures/AudioPlaybackHost.svelte')).default;

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	document.body.replaceChildren();
});

for (const view of ['home', 'detail', 'file'] as const) {
	test(`${view} shows capture progress until Stop finishes, then reads only finalized audio`, async () => {
		const app = await open(view === 'home');
		const { whispering, folder } = app;
		await whispering.startRecording();
		await waitForSaves(folder);
		const entry = whispering.entries[0]!;
		const path = entry.path.replace(/\.md$/, '.wav');
		if (view !== 'home') whispering.open(view === 'detail' ? entry.path : path);
		flushSync();

		await eventually(() => {
			flushSync();
			return app.target.textContent?.includes('Recording…') === true;
		});
		expect(app.target.querySelector('audio') === null).toBe(true);
		expect(app.target.textContent).toContain('Recording…');
		expect(app.reads).toEqual([]);
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
	const { whispering, folder } = app;
	await whispering.startRecording();
	app.finish.resolve();
	await whispering.stopRecording();
	await waitForSaves(folder);
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

test('a player reads its audio again when the folder shows the file changed', async () => {
	const app = await open(false);
	const { whispering, folder } = app;
	await whispering.startRecording();
	app.finish.resolve();
	await whispering.stopRecording();
	await waitForSaves(folder);
	const entry = whispering.entries[0]!;
	const path = entry.path.replace(/\.md$/, '.wav');
	whispering.open(entry.path);
	await eventually(() => {
		flushSync();
		return app.target.querySelector('audio') !== null;
	});
	const before = app.target.querySelector('audio')!.getAttribute('src');
	const reads = app.reads.length;

	// Another take replaces the file: a new listed value, so a new read.
	const longer = toneWav({ seconds: 2 });
	expectOk(await folder.write(path, longer));
	await eventually(() => {
		flushSync();
		return app.reads.length > reads;
	});
	expect(app.reads.at(-1)).toBe(longer.byteLength);
	await eventually(() => {
		flushSync();
		return app.target.querySelector('audio')?.getAttribute('src') !== before;
	});
});

test('a player hides a revoked URL while replacement audio is loading', async () => {
	const app = await open(false);
	const { whispering, folder } = app;
	await whispering.startRecording();
	app.finish.resolve();
	await whispering.stopRecording();
	await waitForSaves(folder);
	const entry = whispering.entries[0]!;
	const path = entry.path.replace(/\.md$/, '.wav');
	whispering.open(entry.path);
	await eventually(() => {
		flushSync();
		return app.target.querySelector('audio') !== null;
	});

	const read = folder.read;
	const next = deferred<Awaited<ReturnType<typeof folder.read>>>();
	folder.read = (requested) =>
		requested === path ? next.promise : read(requested);
	expectOk(await folder.write(path, toneWav({ seconds: 2 })));
	flushSync();
	expect(app.target.querySelector('audio')).toBeNull();
	await eventually(
		() => app.target.textContent?.includes('Loading audio…') === true,
	);

	next.resolve(await read(path));
	await eventually(() => {
		flushSync();
		return app.target.querySelector('audio') !== null;
	});
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
					await options.folder.write(active.audioPath, toneWav().slice(0, 44)),
				);
				return result;
			},
		},
	};
	// Every audio read a view asks the folder for, by the size it answered.
	const reads: number[] = [];
	// SAFETY: the prototype answers every member the replaced read leaves out.
	const folder = Object.create(stubs.folder) as WhisperingFolder;
	folder.read = async (path) => {
		const result = await stubs.folder.read(path);
		if (path.endsWith('.wav') && result.error === null && result.data !== null)
			reads.push(result.data.byteLength);
		return result;
	};
	const { whispering } = await createTestWhispering({
		folder,
		services,
	});
	await whispering.start();
	const target = document.createElement('main');
	document.body.append(target);
	const host = mount(Host, { target, props: { whispering, folder, home } });
	cleanups.push(async () => {
		finish.resolve();
		await unmount(host);
		closeTestWhispering({ whispering, folder });
		await stubs.remove();
	});
	return { whispering, folder, target, finish, reads };
}
