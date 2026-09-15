/** The native bridge sends bounded descriptors, captures its document and owns cancellation. */
import { expect, mock, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { attachmentStorageId } from '@epicenter/blobs';

let perform: (
	command: string,
	args?: Record<string, unknown>,
) => Promise<unknown>;
const invoke = mock((command: string, args?: Record<string, unknown>) =>
	perform(command, args),
);
const nativeCore = await import('@tauri-apps/api/core');
mock.module('@tauri-apps/api/core', () => ({ ...nativeCore, invoke }));
const { epicenterHost } = await import('./epicenter-host.js');
const id = attachmentStorageId('recordings', 'aaaaaaaaaaaaaaaaaaaaaaaa');
const expected = {
	sha256: 'a'.repeat(64),
	size: 5 * 1024 ** 3,
	contentType: 'audio/wav',
};
const ticket = {
	url: 'https://bytes.example/signed',
	requiredHeaders: { 'if-none-match': '*' },
};
function setup() {
	invoke.mockClear();
	perform = async (command) =>
		command === 'attachment_transfer_epoch' ? 4 : undefined;
	return epicenterHost.blobs({
		appId: 'com.test.transfer',
		replica: { library: 'local' },
		remote: null,
	}).local.attachments!;
}

test('native transfers capture one epoch and pass descriptors without byte buffers', async () => {
	const bytes = setup();
	expectOk(
		await bytes.upload(id, expected, ticket, new AbortController().signal),
	);
	expectOk(
		await bytes.download(id, expected, ticket, new AbortController().signal),
	);
	expect(
		invoke.mock.calls.filter(
			([command]) => command === 'attachment_transfer_epoch',
		),
	).toHaveLength(1);
	const transfers = invoke.mock.calls.filter(
		([command]) => command === 'transfer_attachment',
	);
	expect(transfers).toHaveLength(2);
	expect(transfers[0]?.[1]).toMatchObject({
		epoch: 4,
		destination: { appId: 'com.test.transfer', replica: { library: 'local' } },
		storageId: id,
		direction: 'upload',
		expected,
		ticket,
	});
	expect(transfers[1]?.[1]?.requestId).not.toBe(transfers[0]?.[1]?.requestId);
	expect(JSON.stringify(transfers[0]?.[1]).length).toBeLessThan(700);
});

test('request sequences increase across independent library factories in one document', async () => {
	const first = setup();
	const second = epicenterHost.blobs({
		appId: 'com.test.other',
		replica: { library: 'local' },
		remote: null,
	}).local.attachments!;
	await Promise.all([
		first
			.download(id, expected, ticket, new AbortController().signal)
			.then(expectOk),
		second
			.download(id, expected, ticket, new AbortController().signal)
			.then(expectOk),
	]);
	const ids = invoke.mock.calls
		.filter(([command]) => command === 'transfer_attachment')
		.map(([, args]) => Number(args?.requestId));
	expect(ids).toHaveLength(2);
	expect(ids.every((id) => Number.isSafeInteger(id) && id > 0)).toBe(true);
	expect(ids[1]).toBe(ids[0]! + 1);
});

test('abort before epoch resolution cannot admit a late transfer', async () => {
	const bytes = setup();
	const epoch = Promise.withResolvers<number>();
	perform = async () => epoch.promise;
	const controller = new AbortController();
	const result = bytes.download(id, expected, ticket, controller.signal);
	controller.abort();
	epoch.resolve(4);
	expect(expectErr(await result).kind).toBe('transport');
	expect(invoke.mock.calls.map(([command]) => command)).toEqual([
		'attachment_transfer_epoch',
	]);
});

test('abort fences the exact request and drains cancellation before settling', async () => {
	const bytes = setup();
	const entered = Promise.withResolvers<void>();
	const reply = Promise.withResolvers<void>();
	const cancellation = Promise.withResolvers<void>();
	perform = async (command) => {
		if (command === 'attachment_transfer_epoch') return 4;
		if (command === 'transfer_attachment') {
			entered.resolve();
			return reply.promise;
		}
		return cancellation.promise;
	};
	const controller = new AbortController();
	let settled = false;
	const result = bytes
		.download(id, expected, ticket, controller.signal)
		.then((result) => {
			settled = true;
			return result;
		});
	await entered.promise;
	controller.abort();
	reply.resolve();
	await Promise.resolve();
	expect(settled).toBe(false);
	const transfer = invoke.mock.calls.find(
		([command]) => command === 'transfer_attachment',
	)?.[1];
	expect(invoke.mock.calls.at(-1)).toEqual([
		'cancel_attachment_transfer',
		{ epoch: 4, requestId: transfer?.requestId },
	]);
	cancellation.resolve();
	expect(expectErr(await result).kind).toBe('transport');
});

test('native typed failures survive the bridge and a retired factory never refreshes its epoch', async () => {
	const bytes = setup();
	perform = async (command) => {
		if (command === 'attachment_transfer_epoch') return 4;
		throw { kind: 'transport', cause: 'Retired document', status: 412 };
	};
	expect(
		expectErr(
			await bytes.upload(id, expected, ticket, new AbortController().signal),
		),
	).toMatchObject({ kind: 'transport', status: 412 });
	expectErr(
		await bytes.upload(id, expected, ticket, new AbortController().signal),
	);
	expect(
		invoke.mock.calls.filter(
			([command]) => command === 'attachment_transfer_epoch',
		),
	).toHaveLength(1);
});
