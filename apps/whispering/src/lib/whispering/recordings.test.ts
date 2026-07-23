/** Recordings domain evidence over the real Bun record replica. */
import { expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBunRecordEpicenter } from '@epicenter/data/bun';
import { InstantString } from '@epicenter/field';
import { expectOk } from 'wellcrafted/testing';
import { type Recording, type RecordingId, whisperingLens } from '../workspace';
import { createWhisperingRecordings } from './recordings';

function recording(
	overrides: Partial<Omit<Recording, 'id'>> = {},
): Omit<Recording, 'id'> {
	return {
		title: '',
		audioMediaType: 'audio/wav',
		audioFileName: 'recording.wav',
		recordedAt: InstantString.now(),
		recordedAtZone: 'UTC',
		transcript: '',
		polishedTranscript: null,
		duration: null,
		transcription: null,
		...overrides,
	};
}

async function setup() {
	const root = mkdtempSync(join(tmpdir(), 'whispering-recordings-'));
	const epicenter = await openBunRecordEpicenter({ directory: root });
	const table = epicenter.bind({ whispering: whisperingLens }).whispering
		.recordings;
	const domain = createWhisperingRecordings({
		table,
		prepareAudio: (audio) => {
			if (audio.kind !== 'bytes') throw new Error('Unexpected native capture');
			return audio.bytes.stream();
		},
		materializeAudio: (read) => new Response(read).blob(),
		reportBackgroundError: () => undefined,
	});
	await domain.ready;
	return {
		table,
		recordings: domain.recordings,
		async dispose() {
			domain.dispose();
			await epicenter[Symbol.asyncDispose]();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test('creation binds immutable audio to the new recording address', async () => {
	const context = await setup();
	try {
		const row = await context.recordings.create({
			...recording({ title: 'Captured' }),
			audio: {
				kind: 'bytes',
				bytes: new File(['audio'], 'meeting.webm', { type: 'audio/webm' }),
			},
		});
		expect(context.recordings.get(row.id)?.title).toBe('Captured');
		expect(context.recordings.get(row.id)).toMatchObject({
			audioMediaType: 'audio/webm',
			audioFileName: 'meeting.webm',
		});
		const stream = await context.recordings.readAudio(row.id);
		expect(stream).not.toBeNull();
		expect(await stream?.text()).toBe('audio');
		expect(stream?.type).toBe('audio/webm');
		expect(await context.table.blob.inspect(row.id)).toMatchObject({
			kind: 'owed',
		});
	} finally {
		await context.dispose();
	}
});

test('CRUD stays live and recording order is newest first', async () => {
	const context = await setup();
	try {
		const older = await context.recordings.create({
			...recording({
				recordedAt: InstantString.fromDate(
					new Date('2026-07-20T01:00:00.000Z'),
				),
			}),
			audio: { kind: 'bytes', bytes: new Blob(['older']) },
		});
		const newer = await context.recordings.create({
			...recording({
				recordedAt: InstantString.fromDate(
					new Date('2026-07-20T02:00:00.000Z'),
				),
			}),
			audio: { kind: 'bytes', bytes: new Blob(['newer']) },
		});
		expect(context.recordings.sorted.map(({ id }) => id)).toEqual([
			newer.id,
			older.id,
		]);
		expectOk(await context.recordings.update(older.id, { title: 'updated' }));
		expect(context.recordings.get(older.id)?.title).toBe('updated');
		expectOk(
			await context.recordings.update(older.id, {
				audioMediaType: 'text/plain',
				audioFileName: 'mutable.txt',
			} as never),
		);
		expect(context.recordings.get(older.id)).toMatchObject({
			audioMediaType: 'application/octet-stream',
			audioFileName: 'recording.bin',
		});
		expectOk(await context.recordings.delete(newer.id));
		expect(context.recordings.get(newer.id)).toBeUndefined();
		expect(await context.table.blob.inspect(newer.id)).toEqual({
			kind: 'absent',
		});
	} finally {
		await context.dispose();
	}
});

test('a host media URL serves playback without materializing the record blob', async () => {
	const context = await setup();
	const readAudio = mock(
		async (_id: RecordingId, mediaType: string) =>
			new Blob(['streamed'], { type: mediaType }),
	);
	const domain = createWhisperingRecordings({
		table: context.table,
		prepareAudio: (audio) => {
			if (audio.kind !== 'bytes') throw new Error('Unexpected native capture');
			return audio.bytes.stream();
		},
		materializeAudio: async () => {
			throw new Error('generic record materialization must stay unused');
		},
		readAudio,
		audioUrl: (id) => `http://127.0.0.1/media/${id}`,
		reportBackgroundError: () => undefined,
	});
	try {
		await domain.ready;
		const row = await domain.recordings.create({
			...recording(),
			audio: { kind: 'bytes', bytes: new Blob(['stored']) },
		});
		expect(await domain.recordings.readPlaybackAudio(row.id)).toBe(
			`http://127.0.0.1/media/${row.id}`,
		);
		expect(readAudio).not.toHaveBeenCalled();
		expect(await (await domain.recordings.readAudio(row.id))?.text()).toBe(
			'streamed',
		);
		expect(readAudio).toHaveBeenCalledTimes(1);
	} finally {
		domain.dispose();
		await context.dispose();
	}
});

test('blob arrival notifies recording subscribers and becomes readable', async () => {
	const context = await setup();
	try {
		const row = await context.table.create(recording());
		await context.recordings.refresh();
		expect(
			await context.recordings.readAudio(row.id as RecordingId),
		).toBeNull();

		const arrival = Promise.withResolvers<RecordingId[]>();
		const stop = context.recordings.subscribe((changedIds) =>
			arrival.resolve(changedIds),
		);
		await context.table.blob.put(row.id, new Blob(['arrived']).stream());
		expect(await arrival.promise).toEqual([row.id as RecordingId]);
		stop();

		const audio = await context.recordings.readAudio(row.id as RecordingId);
		expect(await audio?.text()).toBe('arrived');
	} finally {
		await context.dispose();
	}
});

test('recording notifications retain the changed address', async () => {
	const context = await setup();
	try {
		const first = await context.table.create(recording({ title: 'first' }));
		await context.table.create(recording({ title: 'second' }));
		await context.recordings.refresh();

		const changed = Promise.withResolvers<RecordingId[]>();
		const stop = context.recordings.subscribe((ids) => changed.resolve(ids));
		await context.table.update(first.id, { title: 'updated' });
		expect(await changed.promise).toEqual([first.id as RecordingId]);
		stop();
	} finally {
		await context.dispose();
	}
});

test('refresh loads and sorts every recording', async () => {
	const context = await setup();
	try {
		for (let index = 0; index < 101; index += 1) {
			await context.table.create(
				recording({
					title: String(index),
					recordedAt: InstantString.fromDate(
						new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
					),
				}),
			);
		}
		await context.recordings.refresh();
		expect(context.recordings.count).toBe(101);
		expect(context.recordings.sorted[0]?.title).toBe('100');
		expect(context.recordings.sorted.at(-1)?.title).toBe('0');
	} finally {
		await context.dispose();
	}
});

test('a failed atomic capture leaves no incomplete row', async () => {
	const context = await setup();
	try {
		const domain = createWhisperingRecordings({
			table: {
				...context.table,
				async createWithBlob() {
					throw new Error('disk full');
				},
			},
			prepareAudio: (audio) => {
				if (audio.kind !== 'bytes')
					throw new Error('Unexpected native capture');
				return audio.bytes.stream();
			},
			materializeAudio: (read) => new Response(read).blob(),
			reportBackgroundError: () => undefined,
		});
		await domain.ready;
		await expect(
			domain.recordings.create({
				...recording(),
				audio: { kind: 'bytes', bytes: new Blob(['audio']) },
			}),
		).rejects.toThrow('disk full');
		expect((await context.table.scan()).rows).toEqual([]);
		domain.dispose();
	} finally {
		await context.dispose();
	}
});

test('native capture acknowledgement runs only after atomic admission', async () => {
	const context = await setup();
	const acknowledgeAdmission = mock(async () => undefined);
	const reported = mock((_cause: unknown) => undefined);
	const domain = createWhisperingRecordings({
		table: context.table,
		prepareAudio: () => new Blob(['native']).stream(),
		materializeAudio: (read) => new Response(read).blob(),
		reportBackgroundError: reported,
	});
	try {
		await domain.ready;
		const created = await domain.recordings.create({
			...recording(),
			audio: {
				kind: 'native-capture',
				captureId: 'capture_0123456789abcdef0123456789abcdef',
				byteLength: 50,
				acknowledgeAdmission,
			},
		});

		expect(created.id).toBeString();
		expect(acknowledgeAdmission).toHaveBeenCalledTimes(1);
		expect(reported).not.toHaveBeenCalled();
	} finally {
		domain.dispose();
		await context.dispose();
	}
});

test('acknowledgement cleanup failure preserves the admitted row', async () => {
	const context = await setup();
	const cleanupError = new Error('ack response lost');
	const reported = mock((_cause: unknown) => undefined);
	const domain = createWhisperingRecordings({
		table: context.table,
		prepareAudio: () => new Blob(['native']).stream(),
		materializeAudio: (read) => new Response(read).blob(),
		reportBackgroundError: reported,
	});
	try {
		await domain.ready;
		const created = await domain.recordings.create({
			...recording(),
			audio: {
				kind: 'native-capture',
				captureId: 'capture_0123456789abcdef0123456789abcdef',
				byteLength: 50,
				acknowledgeAdmission: async () => {
					throw cleanupError;
				},
			},
		});

		expect((await context.table.get(created.id)).data).toBeDefined();
		expect(reported).toHaveBeenCalledWith(cleanupError);
	} finally {
		domain.dispose();
		await context.dispose();
	}
});
