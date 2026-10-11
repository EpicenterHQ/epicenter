/**
 * Shell Close Signal Tests
 *
 * Drives the desktop leaf's `hostClose` through Tauri's own IPC mocks: the
 * shell's `flush-on-close` event is emitted as the shell would, and the
 * page's `flush_done` is recorded where the shell would receive it.
 *
 * Key behaviors:
 * - The page acknowledges only after its flush lands
 * - The page acknowledges even when its flush outlasts its budget
 * - A page that stopped listening neither flushes nor acknowledges
 */
import { afterEach, expect, test } from 'bun:test';
import { flushOnClose } from '@epicenter/svelte/flush-on-close';

// Tauri's mocks install themselves on `window`. This file runs isolated.
Object.assign(globalThis, { window: globalThis });

const { clearMocks, mockIPC } = await import('@tauri-apps/api/mocks');
const { emit } = await import('@tauri-apps/api/event');
const { hostClose } = await import('./shell.tauri.ts');

afterEach(() => clearMocks());

/** The shell's side: commands the page sent, in order. */
function shell() {
	const commands: string[] = [];
	mockIPC(
		(command) => {
			commands.push(command);
		},
		{ shouldMockEvents: true },
	);
	return {
		acknowledged: () => commands.includes('flush_done'),
		close: () => emit('flush-on-close'),
	};
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function until(check: () => boolean, what: string) {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out waiting for ${what}`);
}

test('the page acknowledges only after its flush lands', async () => {
	const host = shell();
	const landing = Promise.withResolvers<void>();
	let flushes = 0;
	const stop = flushOnClose(
		() => {
			flushes++;
			return landing.promise;
		},
		{ hostClose },
	);
	await tick();

	await host.close();
	await until(() => flushes === 1, 'the flush to start');
	await tick();
	expect(host.acknowledged()).toBe(false);
	landing.resolve();
	await until(host.acknowledged, 'the acknowledgement');
	stop();
});

test('the page acknowledges even when its flush outlasts its budget', async () => {
	const host = shell();
	const stop = flushOnClose(() => new Promise(() => {}), {
		hostClose,
		ms: 30,
	});
	await tick();

	await host.close();
	await until(host.acknowledged, 'the acknowledgement');
	stop();
});

test('a page that stopped listening neither flushes nor acknowledges', async () => {
	const host = shell();
	let flushes = 0;
	const stop = flushOnClose(
		async () => {
			flushes++;
		},
		{ hostClose },
	);
	await tick();
	stop();

	await host.close();
	await tick();
	expect(flushes).toBe(0);
	expect(host.acknowledged()).toBe(false);
});
