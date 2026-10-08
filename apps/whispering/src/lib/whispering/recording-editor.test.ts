/**
 * Recording input lifetime over the real store and recordings cache.
 * Verifies draft retention, sparse writes, conflict resolution, polish
 * dependencies, missing rows, write failure, and session departure.
 */
import { expect, test } from 'bun:test';
import { type BlobStore, generateBlobId } from '@epicenter/blobs';
import { InstantString } from '@epicenter/data/field';
import { openMemory } from '@epicenter/data/memory';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { whisperingDefinition } from '../workspace/index.js';
import { createRecordingEditor } from './recording-editor.js';
import { createWhisperingRecordings } from './recordings.js';

async function setup() {
	const data = await openMemory(whisperingDefinition);
	const local: BlobStore = {
		put: async () => Ok(undefined),
		get: async () => Ok(new Blob()),
		stat: async () => Ok({ size: 0, contentType: 'audio/wav' }),
		delete: async () => Ok(undefined),
	};
	const domain = createWhisperingRecordings({
		table: data.tables.recordings,
		blobs: { local, remote: null },
	});
	const recordings = domain.recordings;
	const create = (title: string) =>
		recordings.create({
			audioBlobId: generateBlobId(),
			title,
			transcript: `Saved ${title}`,
			polishedTranscript: `Polished ${title}`,
			recordedAt: InstantString.now(),
			recordedAtZone: 'UTC',
			duration: null,
		});
	const a = create('A');
	const b = create('B');
	const editor = createRecordingEditor(recordings);
	editor.open(a.id);
	return {
		data,
		recordings,
		editor,
		a,
		b,
		async [Symbol.asyncDispose]() {
			editor[Symbol.dispose]();
			domain[Symbol.dispose]();
			await data[Symbol.asyncDispose]();
		},
	};
}

test('editing A survives the real table rebuilding A after a B update', async () => {
	await using f = await setup();
	f.editor.edit(f.a.id, 'transcript', 'Unfinished A');
	f.recordings.patch(f.b.id, { title: 'Changed B' });
	expect(f.recordings.get(f.a.id)).not.toBe(f.a);
	expect(f.editor.state.active?.values.transcript).toBe('Unfinished A');
	expect(f.editor.state.active?.dirty).toBe(true);
	expect(f.editor.state.active?.conflicts).toEqual([]);
});

test('dismissal, switching recordings, and returning resume independent drafts', async () => {
	await using f = await setup();
	f.editor.edit(f.a.id, 'transcript', 'Unfinished A');
	f.editor.close();
	f.editor.open(f.b.id);
	f.editor.edit(f.b.id, 'title', 'Unfinished B');
	f.editor.close();
	f.editor.open(f.a.id);
	expect(f.editor.state.active?.values.transcript).toBe('Unfinished A');
	expect(f.editor.state.drafts).toHaveLength(2);
});

test('Save patches edits while retaining newer untouched fields and polish', async () => {
	await using f = await setup();
	f.editor.edit(f.a.id, 'title', 'My title');
	f.recordings.patch(f.a.id, {
		transcript: 'New transcription',
		polishedTranscript: 'New polish',
		recordedAtZone: 'Asia/Singapore',
	});
	expect(f.editor.state.active?.values.transcript).toBe('New transcription');
	expect(expectOk(f.editor.save(f.a.id)).status).toBe('saved');
	expect(f.recordings.get(f.a.id)).toMatchObject({
		title: 'My title',
		transcript: 'New transcription',
		polishedTranscript: 'New polish',
		recordedAtZone: 'Asia/Singapore',
	});
	expect(f.editor.state.drafts).toEqual([]);
});

test('Save refuses a conflicting field and stale approval cannot replace a later version', async () => {
	await using f = await setup();
	f.editor.edit(f.a.id, 'title', 'My title');
	f.recordings.patch(f.a.id, { title: 'Saved elsewhere' });
	const shown = f.editor.state.active!.conflicts[0]!;
	expect(expectOk(f.editor.save(f.a.id)).status).toBe('conflict');
	f.recordings.patch(f.a.id, { title: 'Even newer title' });
	f.editor.keepDraft(f.a.id, shown);
	expect(expectOk(f.editor.save(f.a.id)).status).toBe('conflict');
	f.editor.keepDraft(f.a.id, f.editor.state.active!.conflicts[0]!);
	expect(expectOk(f.editor.save(f.a.id)).status).toBe('saved');
	expect(f.recordings.get(f.a.id)?.title).toBe('My title');
});

test('a newly arrived polished result requires acknowledgement before raw replacement', async () => {
	await using f = await setup();
	f.editor.edit(f.a.id, 'transcript', 'Manual transcript');
	f.recordings.patch(f.a.id, { polishedTranscript: 'New delivered result' });
	expect(expectOk(f.editor.save(f.a.id)).status).toBe('conflict');
	expect(f.recordings.get(f.a.id)?.polishedTranscript).toBe(
		'New delivered result',
	);
	f.editor.keepDraft(f.a.id, f.editor.state.active!.conflicts[0]!);
	expect(expectOk(f.editor.save(f.a.id)).status).toBe('saved');
	expect(f.recordings.get(f.a.id)).toMatchObject({
		transcript: 'Manual transcript',
		polishedTranscript: null,
	});
});

test('an already saved draft transcript preserves the polish associated with it', async () => {
	await using f = await setup();
	f.editor.edit(f.a.id, 'transcript', 'Matching raw');
	f.editor.edit(f.a.id, 'title', 'Edited title');
	f.recordings.patch(f.a.id, {
		transcript: 'Matching raw',
		polishedTranscript: 'Matching polish',
	});
	expect(expectOk(f.editor.save(f.a.id)).status).toBe('saved');
	expect(f.recordings.get(f.a.id)?.polishedTranscript).toBe('Matching polish');
});

test('use saved drops one edit and Discard adopts the latest saved recording', async () => {
	await using f = await setup();
	f.editor.edit(f.a.id, 'title', 'My title');
	f.editor.edit(f.a.id, 'transcript', 'My transcript');
	f.recordings.patch(f.a.id, {
		title: 'Latest title',
		transcript: 'Latest raw',
		polishedTranscript: 'Latest polish',
	});
	f.editor.useSaved(f.a.id, 'transcript');
	expect(f.editor.state.active?.values.transcript).toBe('Latest raw');
	f.editor.discard(f.a.id);
	expect(f.editor.state.active?.values.title).toBe('Latest title');
	expect(f.editor.state.active?.dirty).toBe(false);
	expect(f.recordings.get(f.a.id)?.polishedTranscript).toBe('Latest polish');
});

test('a deleted recording remains discoverable and editable as an unsavable draft', async () => {
	await using f = await setup();
	f.editor.edit(f.a.id, 'transcript', 'Unfinished A');
	f.editor.close();
	f.data.tables.recordings.delete(f.a.id);
	expect(f.editor.state.drafts[0]).toMatchObject({ id: f.a.id, missing: true });
	f.editor.open(f.a.id);
	f.editor.edit(f.a.id, 'transcript', 'Recovered A');
	expect(f.editor.state.active?.values.transcript).toBe('Recovered A');
	expect(expectOk(f.editor.save(f.a.id)).status).toBe('missing');
	expect(f.recordings.get(f.a.id)).toBeUndefined();
	f.editor.discard(f.a.id);
	expect(f.editor.state.isOpen).toBe(false);
});

test('invalid input and write failures preserve the draft for repair and retry', async () => {
	await using f = await setup();
	f.editor.edit(f.a.id, 'recordedAt', 'unfinished date');
	expect(expectOk(f.editor.save(f.a.id)).status).toBe('invalid-time');
	f.editor.useSaved(f.a.id, 'recordedAt');
	f.editor.edit(f.a.id, 'title', 'Keep this');
	const patch = f.recordings.patch;
	f.recordings.patch = () => {
		throw new Error('Write refused');
	};
	expect(expectErr(f.editor.save(f.a.id)).cause).toBeInstanceOf(Error);
	expect(f.editor.state.active?.values.title).toBe('Keep this');
	expect(f.editor.state.isOpen).toBe(true);
	f.recordings.patch = patch;
	expect(expectOk(f.editor.save(f.a.id)).status).toBe('saved');
});

test('ending the session clears drafts and stale callbacks cannot save or reopen', async () => {
	await using f = await setup();
	f.editor.edit(f.a.id, 'transcript', 'Private unfinished input');
	f.editor[Symbol.dispose]();
	f.editor.open(f.a.id);
	f.editor.edit(f.a.id, 'title', 'Stale input');
	expect(expectOk(f.editor.save(f.a.id)).status).toBe('closed');
	expect(f.editor.state).toEqual({
		isOpen: false,
		active: undefined,
		drafts: [],
	});
	expect(f.recordings.get(f.a.id)?.transcript).toBe('Saved A');
});
