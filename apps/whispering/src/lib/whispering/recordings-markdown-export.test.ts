/**
 * Recording Markdown ZIP export journey.
 * Uses an actual recording row and ZIP serialization, intercepting only the
 * platform download. Titles, transcripts, and complete audio references survive;
 * the export contains descriptive Markdown without loading audio bytes.
 */
import { expect, spyOn, test } from 'bun:test';
import { generateBlobId } from '@epicenter/blobs';
import { InstantString } from '@epicenter/data/field';
import { openMemory } from '@epicenter/data/memory';
import { strFromU8, unzipSync } from 'fflate';
import yaml from 'js-yaml';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { DownloadServiceLive } from '#platform/download';
import { whisperingDefinition } from '../data.js';
import type { WhisperingApp } from './app.js';
import { asRecording } from './recording.js';
import { exportRecordingsMarkdown } from './recordings-markdown-export.js';

test('ZIP export retains row descriptions and full audio keys under recordings.zip', async () => {
	await using store = await openMemory(whisperingDefinition);
	const audioBlobId = generateBlobId('webm');
	const row = asRecording(
		store.tables.recordings.create({
			audioBlobId,
			audioUrl: null,
			title: 'Planning: next release',
			recordedAt: InstantString.fromDate(new Date('2026-09-17T11:33:09Z')),
			recordedAtZone: 'Asia/Singapore',
			transcript: 'First line.\nSecond line with **emphasis**.',
			polishedTranscript: null,
			duration: 4,
			transcriptionStatus: 'complete',
			transcriptionCompletedAt: null,
			transcriptionError: null,
		}),
	);
	const downloaded: Array<{ name: string; blob: Blob }> = [];
	const download = spyOn(
		DownloadServiceLive,
		'downloadBlob',
	).mockImplementation(async (args) => {
		downloaded.push(args);
		return Ok(undefined);
	});
	try {
		const app = {
			recordings: {
				sorted: [row],
				readAudio() {
					throw new Error('Markdown export must not load audio.');
				},
			},
		} as unknown as WhisperingApp;
		expect(expectOk(await exportRecordingsMarkdown(app))).toEqual({
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
		expect(markdown.slice(separator + 5)).toBe(`${row.transcript}\n`);
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
					recordings: { sorted: [] },
				} as unknown as WhisperingApp),
			),
		).toEqual({ written: 0 });
		expect(download).not.toHaveBeenCalled();
	} finally {
		download.mockRestore();
	}
});
