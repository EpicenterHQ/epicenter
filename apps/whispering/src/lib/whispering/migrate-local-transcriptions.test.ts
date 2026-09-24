import { expect, test } from 'bun:test';
import { defineStore, defineTable, field, plainText } from '@epicenter/app';
import { InstantString } from '@epicenter/app/field';
import { createMemoryRecord, openMemory } from '@epicenter/app/memory';
import { generateBlobId } from '@epicenter/blobs';
import { whisperingDefinition } from '../data.js';
import { migrateLocalTranscriptions } from './migrate-local-transcriptions.js';

const legacyDefinition = defineStore({
	id: whisperingDefinition.id,
	title: 'Whispering',
	kv: {},
	tables: {
		recordings: defineTable({
			fields: {
				audioBlobId: field.string(),
				title: field.string(),
				recordedAt: field.instant(),
				recordedAtZone: field.string(),
				duration: field.nullable(field.number()),
				transcript: field.string(),
				polishedTranscript: field.nullable(field.string()),
				transcriptionStatus: field.string(),
				transcriptionCompletedAt: field.nullable(field.instant()),
				transcriptionError: field.nullable(field.string()),
			},
			body: plainText(),
		}),
	},
});

test('older Local transcript becomes one result across reopening without changing audio', async () => {
	const record = createMemoryRecord();
	const first = await openMemory(legacyDefinition, record);
	const recordedAt = InstantString.fromDate(new Date('2026-09-01T10:00:00Z'));
	const audioBlobId = generateBlobId('wav');
	const recording = first.tables.recordings.create({
		audioBlobId,
		title: 'Interview',
		recordedAt,
		recordedAtZone: 'UTC',
		duration: 12,
		transcript: 'Original speech.',
		polishedTranscript: 'Cleaned speech.',
		transcriptionStatus: 'failed',
		transcriptionCompletedAt: recordedAt,
		transcriptionError: 'Later retry failed',
	});
	await first[Symbol.asyncDispose]();

	const second = await openMemory(whisperingDefinition, record);
	await migrateLocalTranscriptions(second);
	expect(second.tables.transcriptions.rows).toMatchObject([
		{
			recordingId: recording.id,
			rawText: 'Original speech.',
			cleanedText: 'Cleaned speech.',
			legacyRecordingId: recording.id,
		},
	]);
	expect(second.tables.recordings.get(recording.id)?.audioBlobId).toBe(
		audioBlobId,
	);
	await second[Symbol.asyncDispose]();

	const third = await openMemory(whisperingDefinition, record);
	await migrateLocalTranscriptions(third);
	expect(third.tables.transcriptions.rows).toHaveLength(1);
	await third[Symbol.asyncDispose]();
});
