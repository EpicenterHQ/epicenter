/** Whispering's real @epicenter/data slice over Bun SQLite replicas. */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateBlobId } from '@epicenter/blobs';
import { defineLens, type ScalarTransport } from '@epicenter/data';
import { openBunEpicenter } from '@epicenter/data/bun';
import { InstantString } from '@epicenter/field';
import { expectOk } from 'wellcrafted/testing';
import { createBunEpicenterSyncRuntime } from '../../../../../packages/server/src/epicenter-sync/bun';
import type { EpicenterSyncV1Authority } from '../../../../../packages/server/src/epicenter-sync/v1-authority';
import { recordingsTable, whisperingSettingValues } from './definition';

/**
 * Call one in-process authority as a scalar transport.
 *
 * The replica only ever talks to a `ScalarTransport`, so a same-process test
 * needs the authority's typed Result restated as a transport outcome: a refusal
 * is a value the replica turns into a terminal or corruption error, while
 * anything else is a response body for the kernel to admit. Skipping this and
 * throwing on refusal would make a lifetime mismatch look like a network fault.
 */
function inProcessTransport(
	authority: EpicenterSyncV1Authority,
): ScalarTransport {
	const outcome = (result: {
		data: unknown;
		error: { name: string; [key: string]: unknown } | null;
	}) => {
		if (result.error === null) {
			return { kind: 'response', body: result.data } as const;
		}
		switch (result.error.name) {
			case 'LifetimeMismatch':
				return {
					kind: 'refused',
					refusal: {
						code: 'lifetime-mismatch',
						activeLifetime: String(result.error.active),
					},
				} as const;
			case 'SequenceAhead':
				return {
					kind: 'refused',
					refusal: { code: 'sequence-ahead' },
				} as const;
			case 'SubmissionFork':
				return {
					kind: 'refused',
					refusal: { code: 'submission-fork' },
				} as const;
			case 'SubmissionGap':
				return {
					kind: 'refused',
					refusal: { code: 'submission-gap' },
				} as const;
			default:
				throw new Error(result.error.name);
		}
	};
	return {
		async readFacts(request) {
			return outcome(authority.readFacts(request));
		},
		async submit(request) {
			return outcome(authority.submit(request));
		},
	};
}

function recording(title: string, recordedAt: InstantString) {
	return {
		audioBlobId: generateBlobId(),
		uploadedAt: null,
		title,
		recordedAt,
		recordedAtZone: 'UTC',
		transcript: '',
		polishedTranscript: null,
		duration: null,
		transcription: null,
	};
}

test('settings values set, get, unset, and subscribe through a composed lens', async () => {
	const root = mkdtempSync(join(tmpdir(), 'whispering-data-settings-'));
	try {
		await using epicenter = await openBunEpicenter({ directory: root });
		const values = epicenter.bind(
			defineLens({
				namespace: 'so.epicenter.whispering',
				tables: {},
				values: whisperingSettingValues,
			}),
		).values;
		let changes = 0;
		const stop = values['settings.transcription.language'].subscribe(() => {
			changes += 1;
		});
		expect(
			expectOk(await values['settings.transcription.language'].get()),
		).toBeUndefined();
		await values['settings.transcription.language'].set('en');
		expect(
			expectOk(await values['settings.transcription.language'].get()),
		).toBe('en');
		await values['settings.transcription.language'].unset();
		expect(
			expectOk(await values['settings.transcription.language'].get()),
		).toBeUndefined();
		expect(changes).toBe(2);
		stop();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('two borrowed lenses compose recordings CRUD with application ordering', async () => {
	const root = mkdtempSync(join(tmpdir(), 'whispering-data-composition-'));
	try {
		await using epicenter = await openBunEpicenter({ directory: root });
		const recordings = epicenter.bind(
			defineLens({
				namespace: 'so.epicenter.whispering',
				tables: { recordings: recordingsTable },
				values: {},
			}),
		).tables.recordings;
		const settings = epicenter.bind(
			defineLens({
				namespace: 'so.epicenter.whispering',
				tables: {},
				values: {
					'settings.transcription.language':
						whisperingSettingValues['settings.transcription.language'],
				},
			}),
		).values;
		const older = await recordings.create(
			recording(
				'older',
				InstantString.fromDate(new Date('2026-07-20T01:00:00.000Z')),
			),
		);
		const newer = await recordings.create(
			recording(
				'newer',
				InstantString.fromDate(new Date('2026-07-20T02:00:00.000Z')),
			),
		);
		const scanned = await recordings.scan();
		expect(
			scanned.rows.toSorted((left, right) =>
				right.recordedAt.localeCompare(left.recordedAt),
			)[0],
		).toEqual(newer);
		expect(
			expectOk(await recordings.update(older.id, { title: 'updated' }))?.title,
		).toBe('updated');
		expect(await recordings.delete(newer.id)).toBe(true);
		expect(expectOk(await recordings.get(newer.id))).toBeUndefined();
		await settings['settings.transcription.language'].set('fr');
		expect(
			expectOk(await settings['settings.transcription.language'].get()),
		).toBe('fr');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('first sign-in freezes attachment and converges through the in-process authority', async () => {
	const root = mkdtempSync(join(tmpdir(), 'whispering-data-attach-'));
	const authority = createBunEpicenterSyncRuntime({
		dir: join(root, 'authority'),
	});
	try {
		await using first = await openBunEpicenter({
			directory: join(root, 'first'),
		});
		await using second = await openBunEpicenter({
			directory: join(root, 'second'),
		});
		const firstLanguage = first.bind(
			defineLens({
				namespace: 'so.epicenter.whispering',
				tables: {},
				values: {
					'settings.transcription.language':
						whisperingSettingValues['settings.transcription.language'],
				},
			}),
		).values['settings.transcription.language'];
		const secondLanguage = second.bind(
			defineLens({
				namespace: 'so.epicenter.whispering',
				tables: {},
				values: {
					'settings.transcription.language':
						whisperingSettingValues['settings.transcription.language'],
				},
			}),
		).values['settings.transcription.language'];
		await firstLanguage.set('de');
		const attachment = Object.freeze({
			deploymentId: 'https://example.com/',
			principalId: 'principal-a',
		});
		const transport = inProcessTransport(
			authority.locateAuthority('principal-a' as never),
		);
		expectOk(await first.attachSync({ ...attachment, transport }));
		expectOk(await second.attachSync({ ...attachment, transport }));
		expect(expectOk(await secondLanguage.get())).toBe('de');
		const refused = await second.attachSync({
			deploymentId: attachment.deploymentId,
			principalId: 'principal-b',
			transport: inProcessTransport(
				authority.locateAuthority('principal-b' as never),
			),
		});
		expect(refused.error?.name).toBe('WrongAttachment');
	} finally {
		authority.close();
		rmSync(root, { recursive: true, force: true });
	}
});
