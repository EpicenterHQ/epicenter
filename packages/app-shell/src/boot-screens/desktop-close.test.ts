/** Native acknowledgements must wait for the document's complete close. */
import { expect, test } from 'bun:test';
import { attachDesktopClose } from './desktop-close.js';

function nativeWindow() {
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	const previousTauri = Object.getOwnPropertyDescriptor(globalThis, 'isTauri');
	const acknowledgements: unknown[] = [];
	let callback: (event: { payload: { requestId: string } }) => void = () => {};
	Object.defineProperty(globalThis, 'isTauri', {
		configurable: true,
		value: true,
	});
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: {
			__TAURI_INTERNALS__: {
				transformCallback(handler: typeof callback) {
					callback = handler;
					return 1;
				},
				async invoke(command: string, args: unknown) {
					if (command === 'finish_application_close')
						acknowledgements.push(args);
					return 1;
				},
			},
			__TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
		},
	});
	return {
		acknowledgements,
		request() {
			callback({ payload: { requestId: 'request' } });
		},
		[Symbol.dispose]() {
			for (const [name, descriptor] of [
				['window', previousWindow],
				['isTauri', previousTauri],
			] as const) {
				if (descriptor) Object.defineProperty(globalThis, name, descriptor);
				else Reflect.deleteProperty(globalThis, name);
			}
		},
	};
}

test('native success acknowledgement waits for App closure', async () => {
	using native = nativeWindow();
	const closed = Promise.withResolvers<void>();
	const stop = await attachDesktopClose(() => closed.promise);
	native.request();
	await Bun.sleep(0);
	expect(native.acknowledgements).toEqual([]);
	closed.resolve();
	await Bun.sleep(0);
	expect(native.acknowledgements).toEqual([
		{ requestId: 'request', error: null },
	]);
	stop();
});

test('a failed close is reported as failure rather than allowing native restart', async () => {
	using native = nativeWindow();
	const stop = await attachDesktopClose(async () => {
		throw new Error('Could not finish writes');
	});
	native.request();
	await Bun.sleep(0);
	expect(native.acknowledgements).toEqual([
		{ requestId: 'request', error: 'Could not finish writes' },
	]);
	stop();
});
