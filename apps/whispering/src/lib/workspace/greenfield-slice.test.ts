/** Whispering's real @epicenter/data slice over Bun SQLite replicas. */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateBlobId } from '@epicenter/blobs';
import {
	createAuthority,
	parseFactsRequest,
	parseSubmissionRequest,
	readFacts,
	SCALAR_SYNC_V1_LIMITS,
	submit,
} from '@epicenter/data/protocol/v1';
import {
	type OpenBunEpicenterOptions,
	openBunEpicenter,
} from '@epicenter/data/runtime/bun';
import { InstantString } from '@epicenter/field';
import { expectOk } from 'wellcrafted/testing';
import { whisperingLens } from './definition';

type BunCarrier = NonNullable<OpenBunEpicenterOptions['carrier']>;

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

/** One in-process scalar authority shared by every carrier it hands out. */
function createTestAuthority() {
	const created = createAuthority('slice-life', SCALAR_SYNC_V1_LIMITS);
	if (created.error !== null) throw created.error;
	let state = created.data;
	function carrier(): BunCarrier {
		return {
			async fetchFacts(request) {
				const admitted = parseFactsRequest(request, SCALAR_SYNC_V1_LIMITS);
				if (admitted.error !== null) throw admitted.error;
				const read = readFacts(state, admitted.data, SCALAR_SYNC_V1_LIMITS);
				if (read.error !== null) throw read.error;
				return read.data;
			},
			async submit(bytes) {
				const admitted = parseSubmissionRequest(
					JSON.parse(bytes),
					SCALAR_SYNC_V1_LIMITS,
				);
				if (admitted.error !== null) throw admitted.error;
				const accepted = submit(state, admitted.data, SCALAR_SYNC_V1_LIMITS);
				if (accepted.error !== null) throw accepted.error;
				state = accepted.data.state;
				return accepted.data.response;
			},
			async publishDocument() {
				throw new Error('Whispering publishes no record documents');
			},
			async publishBlob() {
				throw new Error('Whispering publishes no record blobs');
			},
		};
	}
	return { carrier };
}

test('settings values set, get, unset, and subscribe through the bound lens', async () => {
	const root = mkdtempSync(join(tmpdir(), 'whispering-data-settings-'));
	try {
		await using epicenter = await openBunEpicenter({ directory: root });
		const language = epicenter
			.bind(whisperingLens)
			.settings.record('transcription.language');
		let changes = 0;
		const stop = language.subscribe(() => {
			changes += 1;
		});
		expect(expectOk(await language.get())).toBeUndefined();
		expectOk(await language.set('en'));
		expect(expectOk(await language.get())).toBe('en');
		expectOk(await language.unset());
		expect(expectOk(await language.get())).toBeUndefined();
		expect(changes).toBe(2);
		stop();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('the one bound lens composes recordings CRUD with settings access', async () => {
	const root = mkdtempSync(join(tmpdir(), 'whispering-data-composition-'));
	try {
		await using epicenter = await openBunEpicenter({ directory: root });
		const bound = epicenter.bind(whisperingLens);
		const older = await bound.recordings.create(
			recording(
				'older',
				InstantString.fromDate(new Date('2026-07-20T01:00:00.000Z')),
			),
		);
		const newer = await bound.recordings.create(
			recording(
				'newer',
				InstantString.fromDate(new Date('2026-07-20T02:00:00.000Z')),
			),
		);
		const scanned = await bound.recordings.scan();
		expect(
			scanned.rows.toSorted((left, right) =>
				right.recordedAt.localeCompare(left.recordedAt),
			)[0],
		).toEqual(newer);
		expect(
			expectOk(
				await bound.recordings.record(older.id).update({ title: 'updated' }),
			)?.title,
		).toBe('updated');
		await bound.recordings.record(newer.id).delete();
		expect(
			expectOk(await bound.recordings.record(newer.id).get()),
		).toBeUndefined();
		expectOk(await bound.settings.record('transcription.language').set('fr'));
		expect(
			expectOk(await bound.settings.record('transcription.language').get()),
		).toBe('fr');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('first sign-in brings local records and converges through one authority', async () => {
	const root = mkdtempSync(join(tmpdir(), 'whispering-data-attach-'));
	const authority = createTestAuthority();
	const attachment = Object.freeze({
		deploymentId: 'https://example.com/',
		principalId: 'principal-a',
	});
	try {
		await using first = await openBunEpicenter({
			directory: join(root, 'first'),
			carrier: authority.carrier(),
			intervalMs: 10,
		});
		await using second = await openBunEpicenter({
			directory: join(root, 'second'),
			carrier: authority.carrier(),
			intervalMs: 10,
		});
		const firstLanguage = first
			.bind(whisperingLens)
			.settings.record('transcription.language');
		const secondLanguage = second
			.bind(whisperingLens)
			.settings.record('transcription.language');
		expectOk(await firstLanguage.set('de'));

		// The nonempty replica surfaces the first-attachment choice; bringing
		// mirrors the production composition root's silent adopt.
		const outcome = await first.attach(attachment);
		if (outcome.kind !== 'first-attachment-choice') {
			throw new Error('a nonempty replica must surface the choice');
		}
		await outcome.proceed('bring');
		expect(first.sync.status.attachment).toEqual(attachment);

		expect((await second.attach(attachment)).kind).toBe('attached');
		const until = Date.now() + 5_000;
		while (Date.now() < until) {
			if (expectOk(await secondLanguage.get()) === 'de') break;
			await Bun.sleep(10);
		}
		expect(expectOk(await secondLanguage.get())).toBe('de');

		// Attachment identity is permanent: a second principal is refused.
		await expect(
			second.attach({ ...attachment, principalId: 'principal-b' }),
		).rejects.toThrow(/permanently attached/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
