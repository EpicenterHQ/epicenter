/**
 * Device Outbox Tests
 *
 * A capture made on a device (signed out, offline) is recorded in a sidecar
 * at `.epicenter/outbox/<captureId>.json` so phase 5's upload can send it,
 * send it again after a lost reply, and delete only the version it sent. A
 * miss here is a capture never uploaded, or deleted before the server has
 * it.
 *
 * Key behaviors:
 * - `add` records each file's path and the version it holds, and refuses a version it does not
 * - The sidecar is plain JSON with id, paths, state and receipt
 * - `finish` refuses a capture the server has not acknowledged while its files remain
 * - `finish` deletes each file only at the version the upload sent, and queues one edited since as an update
 * - A capture id is one short path segment: at most 64 characters
 * - `saveCapture` creates a capture's files and records them, and run again
 *   after a partial attempt it finishes rather than refusing
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineContract } from '@epicenter/definition/contract';
import { gitBlobHash } from '@epicenter/definition/merge';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	type Capture,
	type NewFile,
	openDevice,
	outboxOf,
	saveCapture,
} from '../node.js';

const recorder = defineContract({
	name: 'recorder',
	collections: {
		recordings: {
			path: 'recordings/{id}.md',
			fields: { title: { type: 'string' } },
			required: ['title'],
		},
		audio: { path: 'recordings/{id}.{ext}' },
	},
});

const folders: string[] = [];
afterEach(async () => {
	await Promise.all(
		folders.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-outbox-'));
	folders.push(root);
	const device = openDevice(recorder, { path: root });
	const note = expectOk(
		await device.recordings.create({ id: 'r1', title: 'Standup' }),
	);
	const audio = expectOk(
		await device.audio.create({
			id: 'r1',
			ext: 'webm',
			bytes: new Uint8Array([1, 2, 3]),
		}),
	);
	return { root, device, outbox: outboxOf(device), note, audio };
}

const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

test('add records the capture as a pending sidecar naming each path and the version held', async () => {
	const { root, outbox, note, audio } = await setup();
	const capture = expectOk(
		await outbox.add({
			id: 'r1',
			files: [
				{ collection: 'recordings', ...note },
				{ collection: 'audio', ...audio },
			],
		}),
	);
	const expected = {
		id: 'r1',
		paths: {
			'recordings/r1.md': note.version,
			'recordings/r1.webm': audio.version,
		},
		bases: {},
		state: 'pending' as const,
		receipt: null,
	};
	expect(capture).toEqual(expected);
	const sidecar = await readFile(
		join(root, '.epicenter/outbox/r1.json'),
		'utf8',
	);
	expect(JSON.parse(sidecar)).toEqual(expected);
	expect(expectOk(await outbox.list())).toEqual({
		items: [expected],
		invalid: [],
	});
});

test('add refuses a version the device no longer holds, a capture id twice, and an unusable id', async () => {
	const { device, outbox, note } = await setup();
	const edited = expectOk(
		await device.recordings.update(
			{ id: 'r1' },
			{ title: 'Edited' },
			{ over: note.version },
		),
	);
	const stale = expectErr(
		await outbox.add({
			id: 'r1',
			files: [{ collection: 'recordings', ...note }],
		}),
	);
	expect(stale).toMatchObject({ name: 'Conflict', current: edited.version });
	expectOk(
		await outbox.add({
			id: 'r1',
			files: [{ collection: 'recordings', ...edited }],
		}),
	);
	const twice = expectErr(
		await outbox.add({
			id: 'r1',
			files: [{ collection: 'recordings', ...edited }],
		}),
	);
	expect(twice.name).toBe('Occupied');
	const unusable = expectErr(
		await outbox.add({
			id: '../r1',
			files: [{ collection: 'recordings', ...edited }],
		}),
	);
	expect(unusable.name).toBe('Invalid');
	const long = expectErr(
		await outbox.add({
			id: 'a'.repeat(65),
			files: [{ collection: 'recordings', ...edited }],
		}),
	);
	expect(long.name).toBe('Invalid');
	expectOk(
		await outbox.add({
			id: 'a'.repeat(64),
			files: [{ collection: 'recordings', ...edited }],
		}),
	);
});

test('finish refuses a pending capture, and deletes an acknowledged one only at the versions sent', async () => {
	const { root, device, outbox, note, audio } = await setup();
	expectOk(
		await outbox.add({
			id: 'r1',
			files: [
				{ collection: 'recordings', ...note },
				{ collection: 'audio', ...audio },
			],
		}),
	);
	expect(expectErr(await outbox.finish('r1')).name).toBe('NotAcknowledged');
	const landed = 'b'.repeat(40);
	const receipt = {
		commit: 'c0ffee',
		paths: ['recordings/r1.md', 'recordings/r1.webm'],
		blobs: { 'recordings/r1.md': landed },
	};
	const sent = {
		'recordings/r1.md': note.version,
		'recordings/r1.webm': audio.version,
	};
	const acknowledged = expectOk(await outbox.acknowledge('r1', receipt, sent));
	expect(acknowledged).toMatchObject({ state: 'acknowledged', receipt, sent });
	// An edit after the upload read the note: that edit must survive.
	const edited = expectOk(
		await device.recordings.update(
			{ id: 'r1' },
			{ title: 'After upload' },
			{ over: note.version },
		),
	);
	const finished = expectOk(await outbox.finish('r1'));
	expect(finished.kept).toEqual(['recordings/r1.md']);
	// The edit is queued as an update over the version that landed.
	const queued: Capture = {
		id: finished.queued?.id ?? 'missing',
		paths: { 'recordings/r1.md': edited.version },
		bases: { 'recordings/r1.md': landed },
		state: 'pending',
		receipt: null,
	};
	expect(finished.queued).toEqual(queued);
	expect(await exists(join(root, 'recordings/r1.webm'))).toBe(false);
	expect(expectOk(await device.recordings.get({ id: 'r1' })).version).toBe(
		edited.version,
	);
	expect(await exists(join(root, '.epicenter/outbox/r1.json'))).toBe(false);
	expect(expectOk(await outbox.list()).items).toEqual([queued]);
	expect(expectErr(await outbox.acknowledge('r1', receipt, sent)).name).toBe(
		'NotFound',
	);
});

test('finish keeps an edit reverted to the recorded bytes while other bytes were in flight', async () => {
	const { root, device, outbox, note, audio } = await setup();
	expectOk(
		await outbox.add({
			id: 'r1',
			files: [
				{ collection: 'recordings', ...note },
				{ collection: 'audio', ...audio },
			],
		}),
	);
	// Renamed before the upload read it: the uploader sends "Retro".
	const renamed = expectOk(
		await device.recordings.update(
			{ id: 'r1' },
			{ title: 'Retro' },
			{ over: note.version },
		),
	);
	const sentBytes = await readFile(join(root, 'recordings/r1.md'));
	// While the write is in flight, the person renames it back.
	const reverted = expectOk(
		await device.recordings.update(
			{ id: 'r1' },
			{ title: 'Standup' },
			{ over: renamed.version },
		),
	);
	expect(reverted.version).toBe(note.version);
	const landed = gitBlobHash(sentBytes);
	expectOk(
		await outbox.acknowledge(
			'r1',
			{
				commit: 'c0ffee',
				paths: ['recordings/r1.md', 'recordings/r1.webm'],
				blobs: { 'recordings/r1.md': landed },
			},
			{
				'recordings/r1.md': renamed.version,
				'recordings/r1.webm': audio.version,
			},
		),
	);
	const finished = expectOk(await outbox.finish('r1'));
	// "Standup" is not what landed, so it stays and goes up over "Retro".
	expect(finished.kept).toEqual(['recordings/r1.md']);
	expect(finished.queued).toMatchObject({
		paths: { 'recordings/r1.md': note.version },
		bases: { 'recordings/r1.md': landed },
	});
	expect(expectOk(await device.recordings.get({ id: 'r1' })).title).toBe(
		'Standup',
	);
	expect(await exists(join(root, 'recordings/r1.webm'))).toBe(false);
});

test('an unreadable sidecar is listed as invalid, not dropped or thrown', async () => {
	const { root, outbox } = await setup();
	await Bun.write(join(root, '.epicenter/outbox/broken.json'), '{"id": 3');
	expect(expectOk(await outbox.list())).toEqual({
		items: [],
		invalid: ['.epicenter/outbox/broken.json'],
	});
});

test('a pending capture whose files are all gone finishes, with nothing to send', async () => {
	const { device, outbox, note } = await setup();
	expectOk(
		await outbox.add({
			id: 'r1',
			files: [{ collection: 'recordings', ...note }],
		}),
	);
	expectOk(
		await device.recordings.delete({ id: 'r1' }, { over: note.version }),
	);
	expect(expectOk(await outbox.finish('r1'))).toEqual({
		kept: [],
		queued: null,
	});
	expect(expectOk(await outbox.list()).items).toEqual([]);
});

test('finish turns a file deleted on the device after it was sent into a delete over what landed', async () => {
	const { root, device, outbox, note } = await setup();
	expectOk(
		await outbox.add({
			id: 'r1',
			files: [{ collection: 'recordings', ...note }],
		}),
	);
	const landed = 'b'.repeat(40);
	expectOk(
		await outbox.acknowledge(
			'r1',
			{
				commit: 'c0ffee',
				paths: ['recordings/r1.md'],
				blobs: { 'recordings/r1.md': landed },
			},
			{ 'recordings/r1.md': note.version },
		),
	);
	// The person deletes it while the write is in flight: the server has it anyway.
	expectOk(
		await device.recordings.delete({ id: 'r1' }, { over: note.version }),
	);
	const finished = expectOk(await outbox.finish('r1'));
	expect(finished.kept).toEqual(['recordings/r1.md']);
	expect(finished.queued).toMatchObject({
		paths: { 'recordings/r1.md': note.version },
		bases: { 'recordings/r1.md': landed },
		state: 'pending',
	});
	expect(await exists(join(root, 'recordings/r1.md'))).toBe(false);
});

test('saveCapture keeps new files on the device as one capture', async () => {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-outbox-'));
	folders.push(root);
	const device = openDevice(recorder, { path: root });
	const capture = expectOk(
		await saveCapture(device, {
			id: 'c1',
			files: [
				{
					collection: 'audio',
					value: { id: 'r1', ext: 'm4a', bytes: new Uint8Array([7, 8]) },
				},
				{ collection: 'recordings', value: { id: 'r1', title: 'Standup' } },
			],
		}),
	);
	expect(Object.keys(capture.paths).sort()).toEqual([
		'recordings/r1.m4a',
		'recordings/r1.md',
	]);
	expect(expectOk(await device.recordings.get({ id: 'r1' })).title).toBe(
		'Standup',
	);
	expect(expectOk(await outboxOf(device).list()).items).toEqual([capture]);
});

test('saveCapture run again after a partial attempt finishes it', async () => {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-outbox-'));
	folders.push(root);
	const device = openDevice(recorder, { path: root });
	const audio = { id: 'r1', ext: 'm4a', bytes: new Uint8Array([7, 8]) };
	const files: NewFile<typeof recorder>[] = [
		{ collection: 'audio', value: audio },
		{ collection: 'recordings', value: { id: 'r1', title: 'Standup' } },
	];
	// The first attempt kept the audio and stopped.
	expectOk(await device.audio.create(audio));
	const capture = expectOk(await saveCapture(device, { id: 'c1', files }));
	expect(Object.keys(capture.paths)).toHaveLength(2);
	// And once the capture is recorded, saving again answers it.
	expect(expectOk(await saveCapture(device, { id: 'c1', files }))).toEqual(
		capture,
	);
	expect(expectOk(await outboxOf(device).list()).items).toHaveLength(1);
});

test('saveCapture refuses a collection the contract does not have', async () => {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-outbox-'));
	folders.push(root);
	const device = openDevice(recorder, { path: root });
	const refused = expectErr(
		await saveCapture(device, {
			id: 'c1',
			files: [{ collection: 'nope', value: { id: 'x' } } as never],
		}),
	);
	expect(refused.name).toBe('Invalid');
});
