/**
 * Confirmation dialog operation ownership.
 * Compiles the real component's module script with Svelte, without exporting
 * production helpers or replacing runes. Failure stays retryable, duplicate
 * submissions are ignored, and stale completion cannot change a newer dialog.
 */
import { expect, test } from 'bun:test';
import { compileModule, parse } from 'svelte/compiler';

const source = await Bun.file(
	new URL('./confirmation-dialog.svelte', import.meta.url),
).text();
const moduleScript = parse(source, { modern: true }).module;
if (!moduleScript) throw new Error('Confirmation dialog has no module script');
const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(
	source.slice(
		source.indexOf('>', moduleScript.start) + 1,
		source.lastIndexOf('</script>', moduleScript.end),
	),
);
const compiled = compileModule(javascript, {
	filename: 'confirmation-dialog.svelte.js',
}).js.code;
// Execute compiler output with the installed runtime. Only its module import
// and export syntax changes; the state machine and rune operations are intact.
const dialog: typeof import('./confirmation-dialog.svelte').confirmationDialog =
	new Function(
		'$',
		compiled
			.replace(/^import .*;$/m, '')
			.replace('export const confirmationDialog =', 'return'),
	)(await import(import.meta.resolve('svelte/internal/client')));

test('a rejected confirmation keeps input and becomes retryable', async () => {
	let attempts = 0;
	dialog.open({
		title: 'Delete',
		description: 'Delete item',
		input: { confirmationText: 'DELETE' },
		onConfirm() {
			if (++attempts === 1) throw new Error('offline');
		},
	});
	dialog.inputText = 'DELETE';
	await expect(dialog.confirm()).rejects.toThrow('offline');
	expect(dialog.isOpen).toBe(true);
	expect(dialog.isPending).toBe(false);
	expect(dialog.hasFailed).toBe(true);
	expect(dialog.inputText).toBe('DELETE');
	await dialog.confirm();
	expect(attempts).toBe(2);
	expect(dialog.hasFailed).toBe(false);
	expect(dialog.isOpen).toBe(false);
});

test('pending confirmation ignores duplicate submission', async () => {
	const pending = Promise.withResolvers<void>();
	let calls = 0;
	dialog.open({
		title: 'Delete',
		description: 'Delete item',
		onConfirm() {
			calls++;
			return pending.promise;
		},
	});
	const first = dialog.confirm();
	const second = dialog.confirm();
	expect(calls).toBe(1);
	expect(dialog.isPending).toBe(true);
	pending.resolve();
	await Promise.all([first, second]);
	expect(dialog.isPending).toBe(false);
	expect(dialog.isOpen).toBe(false);
});

for (const rejects of [false, true]) {
	test(`stale ${rejects ? 'failure' : 'success'} cannot change a reopened dialog`, async () => {
		const old = Promise.withResolvers<void>();
		const next = Promise.withResolvers<void>();
		let calls = 0;
		const options = {
			title: 'Delete',
			description: 'Delete item',
			onConfirm: () => (++calls === 1 ? old.promise : next.promise),
		};
		dialog.open(options);
		const first = dialog.confirm().catch(() => undefined);
		// Reusing the caller's options object still opens a distinct dialog.
		dialog.open(options);
		const second = dialog.confirm();
		if (rejects) old.reject(new Error('offline'));
		else old.resolve();
		await first;
		expect(dialog.isOpen).toBe(true);
		expect(dialog.isPending).toBe(true);
		expect(dialog.hasFailed).toBe(false);
		next.resolve();
		await second;
		expect(dialog.isOpen).toBe(false);
	});
}

test('incorrect confirmation text does not invoke the action', async () => {
	let calls = 0;
	dialog.open({
		title: 'Delete',
		description: 'Delete item',
		input: { confirmationText: 'DELETE' },
		onConfirm() {
			calls++;
		},
	});
	await dialog.confirm();
	expect(calls).toBe(0);
	expect(dialog.isOpen).toBe(true);
	dialog.close();
});

test('an asynchronous failure retains input and clears failure on retry', async () => {
	const pending = Promise.withResolvers<void>();
	let calls = 0;
	dialog.open({
		title: 'Delete',
		description: 'Delete item',
		input: { confirmationText: 'DELETE' },
		onConfirm: () => (++calls === 1 ? pending.promise : undefined),
	});
	dialog.inputText = 'DELETE';
	const first = dialog.confirm();
	pending.reject(new Error('offline'));
	await expect(first).rejects.toThrow('offline');
	expect(dialog.isOpen).toBe(true);
	expect(dialog.inputText).toBe('DELETE');
	expect(dialog.isPending).toBe(false);
	expect(dialog.hasFailed).toBe(true);
	await dialog.confirm();
	expect(calls).toBe(2);
	expect(dialog.isOpen).toBe(false);
	expect(dialog.hasFailed).toBe(false);
});

test('a synchronous callback cannot reenter confirmation', async () => {
	let calls = 0;
	dialog.open({
		title: 'Delete',
		description: 'Delete item',
		onConfirm() {
			calls++;
			if (calls === 1) void dialog.confirm();
		},
	});
	await dialog.confirm();
	expect(calls).toBe(1);
	expect(dialog.isOpen).toBe(false);
});

test('cancel cannot dismiss an operation while it is pending', async () => {
	const pending = Promise.withResolvers<void>();
	let cancellations = 0;
	dialog.open({
		title: 'Delete',
		description: 'Delete item',
		onConfirm: () => pending.promise,
		onCancel() {
			cancellations++;
		},
	});
	const confirming = dialog.confirm();
	dialog.cancel();
	expect(dialog.isOpen).toBe(true);
	expect(cancellations).toBe(0);
	pending.resolve();
	await confirming;
});

test('a cancel callback can open a replacement without closing it', () => {
	let cancellations = 0;
	dialog.open({
		title: 'First',
		description: 'First item',
		onConfirm() {},
		onCancel() {
			cancellations++;
			dialog.open({
				title: 'Replacement',
				description: 'Next item',
				onConfirm() {},
			});
		},
	});
	dialog.cancel();
	expect(cancellations).toBe(1);
	expect(dialog.isOpen).toBe(true);
	expect(dialog.options?.title).toBe('Replacement');
	dialog.close();
});

for (const dismiss of ['close', 'binding'] as const) {
	for (const rejects of [false, true]) {
		test(`${dismiss} while pending stays closed after ${rejects ? 'failure' : 'success'}`, async () => {
			const pending = Promise.withResolvers<void>();
			let calls = 0;
			dialog.open({
				title: 'Delete',
				description: 'Delete item',
				onConfirm() {
					calls++;
					return pending.promise;
				},
			});
			const first = dialog.confirm().catch(() => undefined);
			if (dismiss === 'close') dialog.close();
			else dialog.isOpen = false;
			await dialog.confirm();
			expect(calls).toBe(1);
			if (rejects) pending.reject(new Error('offline'));
			else pending.resolve();
			await first;
			expect(dialog.isOpen).toBe(false);
			expect(dialog.isPending).toBe(false);
			if (dismiss === 'close') {
				expect(dialog.options).toBeNull();
				expect(dialog.inputText).toBe('');
				expect(dialog.hasFailed).toBe(false);
			}
		});
	}
}
