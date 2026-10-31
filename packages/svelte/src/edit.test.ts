/**
 * Editor-owned edits: typed text shows until its latest immediate save
 * answers. The tests mount a real component so saves and listeners run.
 */
import './svelte-dom.test-support.js';
import { expect, test } from 'bun:test';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';

const { flushSync, mount, unmount } = await import('svelte');
const { default: EditHost } = await import('./fixtures/EditHost.svelte');

const failure = { message: 'disk full' };
type Failure = { message: string };
type Editor = ReturnType<
	typeof import('./edit.svelte.js').edit<string, Failure>
>;

async function until(check: () => boolean) {
	for (let turn = 0; turn < 100 && !check(); turn++) {
		await Bun.sleep(2);
		flushSync();
	}
	expect(check()).toBe(true);
}

function mountedEdit(
	source: () => string,
	save: (value: string) => Promise<Result<unknown, Failure>>,
) {
	const target = document.createElement('div');
	document.body.append(target);
	let editor: Editor | undefined;
	const view = mount(EditHost, {
		target,
		props: {
			source,
			save,
			expose: (edit) => {
				editor = edit;
			},
		},
	});
	flushSync();
	if (editor === undefined) throw new Error('Edit did not mount');
	return {
		editor,
		target,
		async unmount() {
			await unmount(view);
			target.remove();
		},
	};
}

test('each typed value calls save immediately', async () => {
	const calls: string[] = [];
	const mounted = mountedEdit(
		() => 'Disk',
		(value) => {
			calls.push(value);
			return Promise.resolve(Ok(undefined));
		},
	);
	mounted.editor.value = 'A';
	mounted.editor.value = 'AB';
	expect(mounted.editor.value).toBe('AB');
	expect(calls).toEqual(['A', 'AB']);
	await mounted.unmount();
});

test('retry resends the failed value', async () => {
	const calls: string[] = [];
	const mounted = mountedEdit(
		() => 'Disk',
		(value) => {
			calls.push(value);
			return Promise.resolve(calls.length === 1 ? Err(failure) : Ok(undefined));
		},
	);
	mounted.editor.value = 'Typed';
	expectErr(await mounted.editor.landed());
	mounted.editor.retry();
	expect(calls).toEqual(['Typed', 'Typed']);
	await mounted.unmount();
});

test('landed waits for the newest sent value', async () => {
	const pending = Promise.withResolvers<Result<unknown, Failure>>();
	const calls: string[] = [];
	const mounted = mountedEdit(
		() => 'Disk',
		(value) => {
			calls.push(value);
			return pending.promise;
		},
	);
	mounted.editor.value = 'Typed';
	const landed = mounted.editor.landed();
	expect(calls).toEqual(['Typed']);
	pending.resolve(Ok(undefined));
	expectOk(await landed);
	expect(mounted.editor.value).toBe('Disk');
	await mounted.unmount();
});

test('landed waits for newer typing while an older save is out', async () => {
	const first = Promise.withResolvers<Result<unknown, Failure>>();
	const second = Promise.withResolvers<Result<unknown, Failure>>();
	const calls: string[] = [];
	const mounted = mountedEdit(
		() => 'Disk',
		(value) => {
			calls.push(value);
			return calls.length === 1 ? first.promise : second.promise;
		},
	);
	mounted.editor.value = 'First';
	await until(() => calls.length === 1);
	mounted.editor.value = 'Second';
	const landed = mounted.editor.landed();
	expect(calls).toEqual(['First', 'Second']);
	first.resolve(Ok(undefined));
	expect(calls).toEqual(['First', 'Second']);
	second.resolve(Ok(undefined));
	expectOk(await landed);
	await mounted.unmount();
});

test('landed returns a failed save and leaves its error visible', async () => {
	let calls = 0;
	const mounted = mountedEdit(
		() => 'Disk',
		() => {
			calls++;
			return Promise.resolve(Err(failure));
		},
	);
	mounted.editor.value = 'Typed';
	expectErr(await mounted.editor.landed());
	expect(mounted.editor.error).toEqual(failure);
	expect(mounted.editor.value).toBe('Typed');
	await mounted.unmount();
	expect(calls).toBe(1);
	expectOk(await mounted.editor.landed());
	expect(calls).toBe(1);
});

test('older answers do not replace the newest typed value', async () => {
	const first = Promise.withResolvers<Result<unknown, Failure>>();
	const second = Promise.withResolvers<Result<unknown, Failure>>();
	const third = Promise.withResolvers<Result<unknown, Failure>>();
	const calls: string[] = [];
	const mounted = mountedEdit(
		() => 'Disk',
		(value) => {
			calls.push(value);
			switch (calls.length) {
				case 1:
					return first.promise;
				case 2:
					return second.promise;
				default:
					return third.promise;
			}
		},
	);
	mounted.editor.value = 'First';
	await until(() => calls.length === 1);
	mounted.editor.value = 'Second';
	mounted.editor.value = 'Newest';
	expect(calls).toEqual(['First', 'Second', 'Newest']);
	first.resolve(Ok(undefined));
	second.resolve(Ok(undefined));
	await Promise.resolve();
	expect(mounted.editor.value).toBe('Newest');
	third.resolve(Ok(undefined));
	await until(() => mounted.editor.value === 'Disk');
	expect(mounted.editor.value).toBe('Disk');
	await mounted.unmount();
});

test('an edit does not register a beforeunload prompt', async () => {
	const first = Promise.withResolvers<Result<unknown, Failure>>();
	const calls: string[] = [];
	const mounted = mountedEdit(
		() => 'Disk',
		(value) => {
			calls.push(value);
			return calls.length === 1
				? first.promise
				: Promise.resolve(Ok(undefined));
		},
	);
	mounted.editor.value = 'First';
	await until(() => calls.length === 1);
	mounted.editor.value = 'Second';
	const leaving = new Event('beforeunload', { cancelable: true });
	window.dispatchEvent(leaving);
	expect(calls).toEqual(['First', 'Second']);
	expect(leaving.defaultPrevented).toBe(false);
	first.resolve(Ok(undefined));
	await mounted.unmount();
});

test('teardown does not resend input or save after teardown', async () => {
	const calls: string[] = [];
	const mounted = mountedEdit(
		() => 'Disk',
		(value) => {
			calls.push(value);
			return Promise.resolve(Ok(undefined));
		},
	);
	mounted.editor.value = 'Last';
	await mounted.unmount();
	expect(calls).toEqual(['Last']);
	await Bun.sleep(20);
	expect(calls).toEqual(['Last']);
});

test('rejected and thrown saves leave typed input and an error', async () => {
	const rejected = mountedEdit(
		() => 'Disk',
		() => Promise.reject(failure),
	);
	rejected.editor.value = 'Rejected';
	await until(() => rejected.editor.error !== null);
	expect(rejected.editor.error).toEqual(failure);
	expect(rejected.editor.value).toBe('Rejected');
	await rejected.unmount();
	const thrown = mountedEdit(
		() => 'Disk',
		() => {
			throw failure;
		},
	);
	thrown.editor.value = 'Thrown';
	await until(() => thrown.editor.error !== null);
	expect(thrown.editor.error).toEqual(failure);
	await thrown.unmount();
});

test('failed input retries and discard ignores an out answer', async () => {
	let fails = true;
	const pending = Promise.withResolvers<Result<unknown, Failure>>();
	const calls: string[] = [];
	const mounted = mountedEdit(
		() => 'Disk',
		(value) => {
			calls.push(value);
			return fails ? Promise.resolve(Err(failure)) : pending.promise;
		},
	);
	mounted.editor.value = 'Typed';
	await until(() => mounted.editor.error !== null);
	expect(mounted.editor.value).toBe('Typed');
	fails = false;
	mounted.editor.retry();
	expect(calls).toEqual(['Typed', 'Typed']);
	mounted.editor.discard();
	pending.resolve(Ok(undefined));
	await Promise.resolve();
	expect(mounted.editor.value).toBe('Disk');
	expect(mounted.editor.error).toBeNull();
	await mounted.unmount();
});

test('pagehide does not resend an already sent value', async () => {
	const calls: string[] = [];
	const mounted = mountedEdit(
		() => 'Disk',
		(value) => {
			calls.push(value);
			return Promise.resolve(Ok(undefined));
		},
	);
	mounted.editor.value = 'Typed';
	window.dispatchEvent(new Event('pagehide'));
	expectOk(await mounted.editor.landed());
	expect(calls).toEqual(['Typed']);
	await mounted.unmount();
});
