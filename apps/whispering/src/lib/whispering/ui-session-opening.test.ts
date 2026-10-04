import { expect, test } from 'bun:test';
import { createWhisperingUiSessionOpening } from './ui-session-opening';

test('route disposal aborts an in-flight UI session and releases its runtime', async () => {
	const gate = Promise.withResolvers<void>();
	let disposeCalls = 0;
	const owner = createWhisperingUiSessionOpening(async () => {
		await gate.promise;
		return {
			async [Symbol.asyncDispose]() {
				disposeCalls += 1;
			},
		};
	});

	const disposal = owner[Symbol.asyncDispose]();
	gate.resolve();

	await expect(owner.opening).rejects.toThrow();
	await disposal;
	expect(disposeCalls).toBe(1);
});

test('route disposal owns one ordered close after the UI session resolves', async () => {
	let disposeCalls = 0;
	const owner = createWhisperingUiSessionOpening(async () => ({
		async [Symbol.asyncDispose]() {
			disposeCalls += 1;
		},
	}));
	await owner.opening;

	await Promise.all([
		owner[Symbol.asyncDispose](),
		owner[Symbol.asyncDispose](),
	]);

	expect(disposeCalls).toBe(1);
});
