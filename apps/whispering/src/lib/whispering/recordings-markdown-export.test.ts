/**
 * Recording Markdown ZIP export journey.
 * Uses an actual recording row and ZIP serialization, intercepting only the
 * platform download. Titles, transcripts, and complete audio references survive;
 * the export contains descriptive Markdown without loading audio bytes.
 */
import { expect, spyOn, test } from 'bun:test';
import { InstantString } from '@epicenter/app/field';
import { openMemory } from '@epicenter/app/memory';
import { generateBlobId } from '@epicenter/blobs';
import { strFromU8, unzipSync } from 'fflate';
import yaml from 'js-yaml';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { DownloadServiceLive } from '#platform/download';
import { whisperingDefinition } from '../data.js';
import { exportRecordingsMarkdown } from './recordings-markdown-export.js';

test('ZIP export retains row descriptions and full audio keys under recordings.zip', async () => {
	await using store = await openMemory(whisperingDefinition);
	const audioBlobId = generateBlobId('webm');
	const row = store.tables.recordings.create({
		audioBlobId,
		title: 'Planning: next release',
		recordedAt: InstantString.fromDate(new Date('2026-09-17T11:33:09Z')),
		recordedAtZone: 'Asia/Singapore',
		duration: 4,
	});
	store.tables.transcriptions.create({
		recordingId: row.id,
		attemptedAt: row.recordedAt,
		completedAt: row.recordedAt,
		rawText: 'First line.\nSecond line with **emphasis**.',
		cleanedText: 'First line. Second line with emphasis.',
		connectionId: null,
		model: null,
		legacyRecordingId: null,
	});
	store.tables.transcriptions.create({
		recordingId: row.id,
		attemptedAt: InstantString.fromDate(new Date('2026-09-18T11:33:09Z')),
		completedAt: InstantString.fromDate(new Date('2026-09-18T11:33:09Z')),
		rawText: 'A later attempt.',
		cleanedText: null,
		connectionId: null,
		model: null,
		legacyRecordingId: null,
	});
	const downloaded: Array<{ name: string; blob: Blob }> = [];
	const download = spyOn(
		DownloadServiceLive,
		'downloadBlob',
	).mockImplementation(async (args) => {
		downloaded.push(args);
		return Ok(undefined);
	});
	try {
		expect(expectOk(await exportRecordingsMarkdown(store))).toEqual({
			written: 1,
		});
		expect(downloaded).toHaveLength(1);
		const archive = downloaded[0]!;
		expect(archive.name).toBe('recordings.zip');
		expect(archive.blob.type).toBe('application/zip');
		const files = unzipSync(new Uint8Array(await archive.blob.arrayBuffer()));
		expect(Object.keys(files)).toEqual([`${row.id}.md`]);
		const markdown = strFromU8(files[`${row.id}.md`]!);
		const separator = markdown.indexOf('\n---\n', 4);
		expect(separator).toBeGreaterThan(4);
		const metadata = yaml.load(markdown.slice(4, separator));
		expect(metadata).not.toHaveProperty('content');
		expect(metadata).not.toHaveProperty('transcript');
		expect(metadata).toMatchObject({
			id: row.id,
			title: row.title,
			audioBlobId,
			recordedAtZone: 'Asia/Singapore',
		});
		const body = markdown.slice(separator + 5);
		expect(body).toContain('A later attempt.');
		expect(body).toContain('First line.\nSecond line with **emphasis**.');
		expect(body).toContain('First line. Second line with emphasis.');
		expect(body.indexOf('A later attempt.')).toBeLessThan(
			body.indexOf('First line.'),
		);
	} finally {
		download.mockRestore();
	}
});

test('an empty recording collection produces no download', async () => {
	const download = spyOn(
		DownloadServiceLive,
		'downloadBlob',
	).mockImplementation(async () => {
		throw new Error('Empty export must not download.');
	});
	try {
		expect(
			expectOk(
				await exportRecordingsMarkdown({
					tables: { recordings: { rows: [] } },
				} as unknown as import('./app.js').WhisperingData),
			),
		).toEqual({ written: 0 });
		expect(download).not.toHaveBeenCalled();
	} finally {
		download.mockRestore();
	}
});
