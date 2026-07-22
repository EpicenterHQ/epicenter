import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
	DOCUMENT_PUBLICATION_VERSION,
	documentPayloadDigest,
} from '@epicenter/data/document-v1';
import {
	parseSubmissionRequest,
	type RecordAddress,
	SCALAR_SYNC_V1_LIMITS,
} from '@epicenter/data/protocol/v1';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import { expectOk } from 'wellcrafted/testing';

import { openScalarAuthorityV1 } from './authority-v1.js';
import { createAuthorityCaptureManifestV1 } from './capture-manifest-v1.js';

const LIFETIME = 'lifetime-one';
const CAPTURE_ID = 'cccccccccccccccccccccccc';
const REPLICA_ID = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const A: RecordAddress = {
	namespace: 'so.epicenter.notes',
	collection: 'notes',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
};
const B: RecordAddress = { ...A, recordKey: 'bbbbbbbbbbbbbbbbbbbbbbbb' };
const C: RecordAddress = { ...A, recordKey: 'cccccccccccccccccccccccc' };

function setup() {
	const raw = new Database(':memory:', { strict: true });
	const database = createBunSqliteAdapter(raw);
	const authority = openScalarAuthorityV1({
		database,
		limits: SCALAR_SYNC_V1_LIMITS,
		initialize: { authorityLifetime: LIFETIME },
	});
	const captures = createAuthorityCaptureManifestV1(database);
	let submissionNumber = 1;
	function submit(
		address: RecordAddress,
		op: { kind: 'replace'; value: { title: string } } | { kind: 'tombstone' },
	): void {
		expectOk(
			authority.submit(
				expectOk(
					parseSubmissionRequest(
						{
							authorityLifetime: LIFETIME,
							replicaId: REPLICA_ID,
							submissionNumber,
							intents: [
								op.kind === 'replace'
									? { address, op: 'replace', value: op.value }
									: { address, op: 'tombstone' },
							],
						},
						SCALAR_SYNC_V1_LIMITS,
					),
				),
			),
		);
		submissionNumber += 1;
	}
	return { raw, database, authority, captures, submit };
}

function dependentUpdates(): [Uint8Array, Uint8Array] {
	const document = new Y.Doc({ gc: true });
	const updates: Uint8Array[] = [];
	document.on('updateV2', (update: Uint8Array) => {
		updates.push(new Uint8Array(update));
	});
	document.get('body').insert(0, 'first');
	document.get('body').insert(5, ' second');
	document.destroy();
	const first = updates[0];
	const second = updates[1];
	if (first === undefined || second === undefined) {
		throw new Error('dependent updates were not emitted');
	}
	return [first, second];
}

function publish(
	authority: ReturnType<typeof openScalarAuthorityV1>,
	address: RecordAddress,
	payload: Uint8Array,
): void {
	expect(
		authority.acceptDocument({
			authorityLifetime: LIFETIME,
			address,
			protocolVersion: DOCUMENT_PUBLICATION_VERSION,
			payload,
			digest: documentPayloadDigest(payload),
		}),
	).toMatchObject({ kind: 'accepted' });
}

test('capture manifest catches mutations behind its cursor and seals one cut', () => {
	const context = setup();
	try {
		context.submit(A, { kind: 'replace', value: { title: 'old' } });
		context.submit(B, { kind: 'replace', value: { title: 'removed' } });
		context.captures.start(CAPTURE_ID);
		expect(context.captures.advance(CAPTURE_ID, 1)).toMatchObject({
			kind: 'advanced',
			processedRecords: 1,
		});

		context.submit(A, { kind: 'replace', value: { title: 'new' } });
		context.submit(B, { kind: 'tombstone' });
		context.submit(C, { kind: 'replace', value: { title: 'added' } });
		while (true) {
			const progress = context.captures.advance(CAPTURE_ID, 2);
			expect(progress.kind).toBe('advanced');
			if (progress.kind === 'advanced' && progress.caughtUp) break;
		}
		expect(context.captures.seal(CAPTURE_ID)).toEqual({
			kind: 'sealed',
			captureRevision: 5,
			recordCount: 2,
		});
		const page = context.captures.readPage(CAPTURE_ID);
		expect(page.entries).toMatchObject([
			{ address: A, scalar: { state: 'live', payload: { title: 'new' } } },
			{ address: C, scalar: { state: 'live', payload: { title: 'added' } } },
		]);
		expect(() => context.captures.start('dddddddddddddddddddddddd')).toThrow();
		context.captures.finish(CAPTURE_ID, 'succeeded');
		expect(() => context.captures.readPage(CAPTURE_ID)).toThrow(
			'only a sealed capture can be copied',
		);
		context.captures.start('dddddddddddddddddddddddd');
	} finally {
		context.raw.close();
	}
});

test('capture refuses unresolved document dependencies and succeeds after settlement', () => {
	const context = setup();
	try {
		context.submit(A, { kind: 'replace', value: { title: 'document' } });
		const [first, dependent] = dependentUpdates();
		publish(context.authority, A, dependent);
		context.captures.start(CAPTURE_ID);
		expect(context.captures.advance(CAPTURE_ID)).toEqual({
			kind: 'document-not-settled',
			address: A,
		});
		publish(context.authority, A, first);
		expect(context.captures.advance(CAPTURE_ID)).toMatchObject({
			kind: 'advanced',
			caughtUp: true,
		});
		expect(context.captures.seal(CAPTURE_ID)).toMatchObject({
			kind: 'sealed',
		});
		expect(
			context.captures.readPage(CAPTURE_ID).entries[0]?.documentUpdateV2,
		).toBeInstanceOf(Uint8Array);
	} finally {
		context.raw.close();
	}
});

test('reopening an authority marks interrupted captures crashed and releases pins', () => {
	const context = setup();
	try {
		context.submit(A, { kind: 'replace', value: { title: 'captured' } });
		context.captures.start(CAPTURE_ID);
		context.captures.advance(CAPTURE_ID);
		openScalarAuthorityV1({
			database: context.database,
			limits: SCALAR_SYNC_V1_LIMITS,
		});
		expect(
			context.raw
				.query<{ state: string }, [string]>(
					'SELECT state FROM capture_manifests WHERE capture_id = ?',
				)
				.get(CAPTURE_ID)?.state,
		).toBe('crashed');
		expect(
			context.raw
				.query<{ count: number }, []>(
					'SELECT count(*) AS count FROM capture_manifest_records',
				)
				.get()?.count,
		).toBe(0);
	} finally {
		context.raw.close();
	}
});
