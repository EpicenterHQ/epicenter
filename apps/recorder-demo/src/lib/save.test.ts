import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { timeId } from '@epicenter/definition/ids';
import { openDevice, outboxOf } from '@epicenter/folder/node';
import { expectOk } from 'wellcrafted/testing';
import { recorder } from '../contract.ts';
import { saveRecording } from './save.ts';

const scratch = await mkdtemp(join(tmpdir(), 'recorder-demo-'));
afterAll(() => rm(scratch, { recursive: true, force: true }));

async function device() {
	const root = await mkdtemp(join(scratch, 'device-'));
	const opened = openDevice(recorder, { path: root });
	return { root, device: opened };
}

const recording = (id: string) => ({
	id,
	title: 'Standup',
	recordedAt: '2026-10-31T09:00:00.000Z',
	durationMs: 1500,
	ext: 'm4a',
	bytes: new Uint8Array([1, 2, 3]),
});

test('a saved recording is its audio, its note and one capture naming both', async () => {
	const { root, device: opened } = await device();
	const id = timeId();
	expectOk(await saveRecording(opened, recording(id)));

	expect((await readdir(join(root, 'recordings'))).sort()).toEqual(
		[`${id}.m4a`, `${id}.md`].sort(),
	);
	const [capture] = expectOk(await outboxOf(opened).list()).items;
	expect(capture?.id).toBe(id);
	expect(Object.keys(capture?.paths ?? {}).sort()).toEqual(
		[`recordings/${id}.m4a`, `recordings/${id}.md`].sort(),
	);
	expect(expectOk(await opened.recordings.get({ id }))).toMatchObject({
		title: 'Standup',
		durationMs: 1500,
	});
});

test('a save that stopped partway runs again to the end, from the same recording', async () => {
	const { device: opened } = await device();
	const id = timeId();
	const saving = recording(id);
	// The first attempt kept the audio, then failed before the note.
	expectOk(
		await opened.audio.create({ id, ext: saving.ext, bytes: saving.bytes }),
	);

	expectOk(await saveRecording(opened, saving));
	const { items } = expectOk(await outboxOf(opened).list());
	expect(items.map(({ id }) => id)).toEqual([id]);
	expect(Object.keys(items[0]?.paths ?? {}).sort()).toEqual(
		[`recordings/${id}.m4a`, `recordings/${id}.md`].sort(),
	);
	// Run once more, as a second retry would: nothing changes, nothing fails.
	expectOk(await saveRecording(opened, saving));
	expect(expectOk(await outboxOf(opened).list()).items).toHaveLength(1);
});
