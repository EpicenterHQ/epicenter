import { expect, test } from 'bun:test';
import { InstantString } from '@epicenter/app/field';
import { openMemory } from '@epicenter/app/memory';
import { generateBlobId } from '@epicenter/blobs';
import { defineErrors } from 'wellcrafted/error';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { whisperingDefinition } from '../data.js';
import type { WhisperingApp, WhisperingData } from '../whispering/app.js';
import { createPendingSaves } from '../whispering/pending-saves.js';
import { recordTranscriptionOutcome, saveCleanedTranscription } from './transcription-history.js';

const Failure = defineErrors({ Failed: () => ({ message: 'Provider failed' }) });

async function setup() {
	const store = await openMemory(whisperingDefinition);
	const signal = new AbortController().signal;
	const pendingSaves = createPendingSaves(signal);
	const app = { signal, pendingSaves } as WhisperingApp;
	const recording = store.tables.recordings.create({
		audioBlobId: generateBlobId('wav'),
		title: '',
		recordedAt: InstantString.now(),
		recordedAtZone: 'UTC',
		duration: null,
	});
	return { store, app, recording, pendingSaves };
}

test('separate attempts keep their Originals and cleanup stays with its source', async () => {
	const { store, app, recording } = await setup();
	try {
		const first = expectOk(await recordTranscriptionOutcome(app, store, recording.id, Ok('Original A')));
		const second = expectOk(await recordTranscriptionOutcome(app, store, recording.id, Ok('Original B')));
		expect(first.resultId).not.toBe(second.resultId);
		expectOk(await saveCleanedTranscription(app, store, first.resultId!, {
			rawText: 'Original A', cleanedText: null,
		}, 'Cleaned A'));
		expect(store.tables.transcriptions.get(first.resultId!)?.cleanedText).toBe('Cleaned A');
		expect(store.tables.transcriptions.get(second.resultId!)?.cleanedText).toBeNull();
		expect(store.tables.transcriptions.get(second.resultId!)?.rawText).toBe('Original B');
	} finally {
		await store[Symbol.asyncDispose]();
	}
});

test('failed inference retains successful result and writes no failed result', async () => {
	const { store, app, recording } = await setup();
	try {
		expectOk(await recordTranscriptionOutcome(app, store, recording.id, Ok('Usable text')));
		expectErr(await recordTranscriptionOutcome(app, store, recording.id, Failure.Failed()));
		expect(store.tables.transcriptions.rows).toHaveLength(1);
	} finally {
		await store[Symbol.asyncDispose]();
	}
});

test('finish saving reuses one result identity after an unconfirmed flush', async () => {
	const { store, app, recording, pendingSaves } = await setup();
	try {
		let attempts = 0;
		const data = {
			...store,
			persistence: {
				...store.persistence,
				flush: async () => {
					if (attempts++ === 0) throw new Error('Disk unavailable');
					await store.persistence.flush();
				},
			},
		} as WhisperingData;
		const result = expectOk(await recordTranscriptionOutcome(app, data, recording.id, Ok('Retained')));
		expect(result.history.error).not.toBeNull();
		expect(pendingSaves.entries).toHaveLength(1);
		await pendingSaves.entries[0]!.retry();
		expect(pendingSaves.entries).toHaveLength(0);
		expect(store.tables.transcriptions.rows).toHaveLength(1);
		expect(store.tables.transcriptions.rows[0]?.id).toBe(result.resultId!);
	} finally {
		await store[Symbol.asyncDispose]();
	}
});

test('stale cleanup preview does not replace a newer accepted version', async () => {
	const { store, app, recording } = await setup();
	try {
		const result = expectOk(await recordTranscriptionOutcome(app, store, recording.id, Ok('Original')));
		const expected = { rawText: 'Original', cleanedText: null };
		expectOk(await saveCleanedTranscription(app, store, result.resultId!, expected, 'First'));
		expectErr(await saveCleanedTranscription(app, store, result.resultId!, expected, 'Stale'));
		expect(store.tables.transcriptions.get(result.resultId!)?.cleanedText).toBe('First');
	} finally {
		await store[Symbol.asyncDispose]();
	}
});
