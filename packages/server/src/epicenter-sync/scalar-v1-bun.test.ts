import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	BLOB_PUBLICATION_VERSION,
	blobFileOwner,
} from '@epicenter/data/blob-v1';
import {
	DOCUMENT_PUBLICATION_VERSION,
	type DocumentPublicationRequest,
	documentPayloadDigest,
} from '@epicenter/data/document-v1';
import {
	parseFactsRequest,
	parseSubmissionRequest,
	SCALAR_SYNC_V1_LIMITS,
	sha256Hex,
} from '@epicenter/data/protocol/v1';
import { asPrincipalId } from '@epicenter/identity';
import { encodeDocumentFrame } from '@epicenter/sync/document-v3';
import * as Y from '@y/y';
import type { ServerWebSocket } from 'bun';
import { expectOk } from 'wellcrafted/testing';
import { bunPortableBlobPath } from './bun-backup-v1.js';
import type { BunDataDocumentV1SocketData } from './document-realtime-v1-bun.js';
import { createBunScalarV1Runtime } from './scalar-v1-bun.js';

const REPLICA = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const LIVE = {
	namespace: 'so.epicenter.notes',
	collection: 'recordings',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
} as const;
const UNSET = { ...LIVE, recordKey: 'bbbbbbbbbbbbbbbbbbbbbbbb' } as const;
const TOMBSTONE = { ...LIVE, recordKey: 'cccccccccccccccccccccccc' } as const;

function documentUpdate(value: string): Uint8Array {
	const document = new Y.Doc({ gc: true });
	document.get('content').insert(0, value);
	const update = new Uint8Array(Y.encodeStateAsUpdateV2(document));
	document.destroy();
	return update;
}

async function textOf(source: ReadableStream<Uint8Array>): Promise<string> {
	return new Response(source).text();
}

test('Bun scalar V1 runtime reopens one durable authority per principal', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'epicenter-scalar-v1-bun-'));
	const principal = asPrincipalId('principal-one');
	let runtime = createBunScalarV1Runtime({ dir });
	try {
		let authority = await runtime.locateAuthority(principal);
		const lifetime = expectOk(
			await authority.readFacts(
				expectOk(
					parseFactsRequest({ afterSequence: 0 }, SCALAR_SYNC_V1_LIMITS),
				),
			),
		).authorityLifetime;
		const request = expectOk(
			parseSubmissionRequest(
				{
					authorityLifetime: lifetime,
					replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
					submissionNumber: 1,
					intents: [
						{
							address: {
								namespace: 'so.epicenter.notes',
								collection: 'recordings',
								recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
							},
							op: 'replace',
							value: 'persisted',
						},
					],
				},
				SCALAR_SYNC_V1_LIMITS,
			),
		);
		expect(expectOk(await authority.submit(request)).facts[0]).toMatchObject({
			sequence: 1,
			payload: 'persisted',
		});
		const document = new Y.Doc({ gc: true });
		document.get('content').insert(0, 'durable document');
		const payload = new Uint8Array(Y.encodeStateAsUpdateV2(document));
		document.destroy();
		const publication: DocumentPublicationRequest = {
			authorityLifetime: lifetime,
			address:
				request.intents[0]?.address ??
				(() => {
					throw new Error('missing intent');
				})(),
			protocolVersion: DOCUMENT_PUBLICATION_VERSION,
			payload,
			digest: documentPayloadDigest(payload),
		};
		expect((await authority.acceptDocument(publication)).kind).toBe('accepted');

		await runtime.close();
		runtime = createBunScalarV1Runtime({ dir });
		authority = await runtime.locateAuthority(principal);
		expect(expectOk(await authority.submit(request)).facts[0]).toMatchObject({
			sequence: 1,
			payload: 'persisted',
		});
		expect((await authority.acceptDocument(publication)).kind).toBe('accepted');

		const sent: Uint8Array[] = [];
		const closed: { code?: number; reason?: string }[] = [];
		const socket = {
			data: {
				surface: 'epicenter-data-document',
				principalId: principal,
				address: publication.address,
				authorityLifetime: lifetime,
				authorizationExpiresAt: Date.now() + 60_000,
			},
			send(data: Uint8Array) {
				sent.push(new Uint8Array(data));
			},
			close(code?: number, reason?: string) {
				closed.push({ code, reason });
			},
		} as unknown as ServerWebSocket<BunDataDocumentV1SocketData>;
		runtime.websocket.open?.(socket);
		const empty = new Y.Doc({ gc: true });
		const stateVector = Y.encodeStateVector(empty);
		empty.destroy();
		runtime.websocket.message?.(
			socket,
			Buffer.from(encodeDocumentFrame({ kind: 'sync-request', stateVector })),
		);
		expect(sent).toHaveLength(2);
		const blobDigest = sha256Hex('recorded audio');
		const blobs = await runtime.locateBlobAuthority(principal);
		expect(
			await blobs.accept(
				{
					authorityLifetime: lifetime,
					address: publication.address,
					protocolVersion: BLOB_PUBLICATION_VERSION,
					digest: blobDigest,
				},
				new Blob(['recorded audio']).stream(),
			),
		).toMatchObject({ kind: 'accepted' });
		const owner = blobFileOwner(publication.address, blobDigest);
		const blobPath = join(
			dir,
			'principals',
			'principal-one',
			'authorities',
			lifetime,
			'blobs',
			'content',
			owner.ownerKey,
			owner.digest,
		);
		expect(existsSync(blobPath)).toBe(true);
		expectOk(
			await authority.submit(
				expectOk(
					parseSubmissionRequest(
						{
							authorityLifetime: lifetime,
							replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
							submissionNumber: 2,
							intents: [{ address: publication.address, op: 'tombstone' }],
						},
						SCALAR_SYNC_V1_LIMITS,
					),
				),
			),
		);
		expect(closed).toEqual([{ code: 1000, reason: 'record-not-live' }]);
		await runtime.locateBlobAuthority(principal);
		expect(existsSync(blobPath)).toBe(false);
	} finally {
		await runtime.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('Bun Restore atomically replaces one principal authority and survives restart', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'epicenter-restore-activation-'));
	const principal = asPrincipalId('principal-one');
	let runtime = createBunScalarV1Runtime({ dir });
	try {
		const authority = await runtime.locateAuthority(principal);
		const blobs = await runtime.locateBlobAuthority(principal);
		const backups = await runtime.locateBackupOwner(principal);
		const initial = expectOk(
			await authority.readFacts(
				expectOk(
					parseFactsRequest({ afterSequence: 0 }, SCALAR_SYNC_V1_LIMITS),
				),
			),
		);
		const oldLifetime = initial.authorityLifetime;
		const first = expectOk(
			parseSubmissionRequest(
				{
					authorityLifetime: oldLifetime,
					replicaId: REPLICA,
					submissionNumber: 1,
					intents: [
						{ address: LIVE, op: 'replace', value: 'portable' },
						{ address: UNSET, op: 'replace', value: 'temporary' },
						{ address: TOMBSTONE, op: 'replace', value: 'temporary' },
					],
				},
				SCALAR_SYNC_V1_LIMITS,
			),
		);
		expectOk(await authority.submit(first));
		expectOk(
			await authority.submit(
				expectOk(
					parseSubmissionRequest(
						{
							authorityLifetime: oldLifetime,
							replicaId: REPLICA,
							submissionNumber: 2,
							intents: [
								{ address: UNSET, op: 'unset' },
								{ address: TOMBSTONE, op: 'tombstone' },
							],
						},
						SCALAR_SYNC_V1_LIMITS,
					),
				),
			),
		);

		const update = documentUpdate('portable document');
		const oldDocumentPublication = {
			authorityLifetime: oldLifetime,
			address: LIVE,
			protocolVersion: DOCUMENT_PUBLICATION_VERSION,
			payload: update,
			digest: documentPayloadDigest(update),
		} as const;
		expect(
			await authority.acceptDocument(oldDocumentPublication),
		).toMatchObject({
			kind: 'accepted',
		});
		const digest = sha256Hex('portable blob');
		const oldBlobPublication = {
			authorityLifetime: oldLifetime,
			address: LIVE,
			protocolVersion: BLOB_PUBLICATION_VERSION,
			digest,
		} as const;
		expect(
			await blobs.accept(
				oldBlobPublication,
				new Blob(['portable blob']).stream(),
			),
		).toMatchObject({ kind: 'accepted' });

		const backup = await backups.create();
		expect(backup.recordCount).toBe(2);
		expectOk(
			await authority.submit(
				expectOk(
					parseSubmissionRequest(
						{
							authorityLifetime: oldLifetime,
							replicaId: REPLICA,
							submissionNumber: 3,
							intents: [
								{ address: LIVE, op: 'replace', value: 'after-backup' },
							],
						},
						SCALAR_SYNC_V1_LIMITS,
					),
				),
			),
		);

		const interruptedRead = await blobs.read(LIVE);
		if (interruptedRead === undefined) throw new Error('live blob is missing');
		const interruptedReader = interruptedRead.getReader();
		const restored = await runtime.restoreBackup(principal, backup.backupId);
		expect(restored.recordCount).toBe(2);
		expect(restored.authorityLifetime).not.toBe(oldLifetime);
		const newLifetime = restored.authorityLifetime;
		await expect(interruptedReader.read()).rejects.toThrow(
			'interrupted by authority replacement',
		);
		interruptedReader.releaseLock();

		const oldFacts = await authority.readFacts(
			expectOk(
				parseFactsRequest(
					{ authorityLifetime: oldLifetime, afterSequence: 0 },
					SCALAR_SYNC_V1_LIMITS,
				),
			),
		);
		expect(oldFacts.error?.name).toBe('LifetimeMismatch');
		expect((await authority.submit(first)).error?.name).toBe(
			'LifetimeMismatch',
		);
		expect(
			await authority.acceptDocument(oldDocumentPublication),
		).toMatchObject({
			kind: 'lifetime-mismatch',
			activeAuthorityLifetime: newLifetime,
		});
		expect(
			await blobs.accept(
				oldBlobPublication,
				new Blob(['portable blob']).stream(),
			),
		).toMatchObject({
			kind: 'lifetime-mismatch',
			activeAuthorityLifetime: newLifetime,
		});

		const facts = expectOk(
			await authority.readFacts(
				expectOk(
					parseFactsRequest({ afterSequence: 0 }, SCALAR_SYNC_V1_LIMITS),
				),
			),
		);
		expect(facts.authorityLifetime).toBe(newLifetime);
		expect(facts.facts).toEqual([
			{ address: LIVE, sequence: 1, state: 'live', payload: 'portable' },
			{ address: UNSET, sequence: 2, state: 'unset' },
		]);
		const restoredBlob = await blobs.read(LIVE);
		if (restoredBlob === undefined) throw new Error('restored blob is missing');
		expect(await textOf(restoredBlob)).toBe('portable blob');
		const restoredRaw = new Database(
			join(
				dir,
				'principals',
				'principal-one',
				'authorities',
				newLifetime,
				'data-v1.sqlite',
			),
			{ readonly: true, strict: true },
		);
		expect(
			restoredRaw
				.query(
					`SELECT
						(SELECT count(*) FROM replica_witness) AS witnesses,
						(SELECT count(*) FROM capture_manifests) AS captures,
						(SELECT count(*) FROM records WHERE state = 'tombstone') AS tombstones`,
				)
				.get(),
		).toEqual({ witnesses: 0, captures: 0, tombstones: 0 });
		restoredRaw.close();

		const recaptured = await backups.create();
		const artifact = new Database(
			join(recaptured.directory, 'epicenter.sqlite'),
			{
				readonly: true,
				strict: true,
			},
		);
		const row = artifact
			.query<
				{ document_update_v2: Uint8Array; blob_sha256: string },
				[string, string, string]
			>(
				`SELECT document_update_v2, blob_sha256 FROM _epicenter_records
				WHERE namespace = ? AND collection = ? AND record_key = ?`,
			)
			.get(LIVE.namespace, LIVE.collection, LIVE.recordKey);
		artifact.close();
		if (row === null) throw new Error('recaptured portable record is missing');
		const document = new Y.Doc({ gc: true });
		Y.applyUpdateV2(document, new Uint8Array(row.document_update_v2));
		expect(document.get('content').toString()).toBe('portable document');
		document.destroy();
		expect(row.blob_sha256).toBe(digest);
		expect(
			await Bun.file(
				bunPortableBlobPath(recaptured.directory, LIVE, digest),
			).text(),
		).toBe('portable blob');

		const authorityRaw = new Database(
			join(
				dir,
				'principals',
				'principal-one',
				'authorities',
				newLifetime,
				'data-v1.sqlite',
			),
			{ readonly: true, strict: true },
		);
		expect(
			authorityRaw
				.query(
					`SELECT
						(SELECT count(*) FROM replica_witness) AS witnesses,
						(SELECT count(*) FROM capture_manifests) AS captures,
						(SELECT count(*) FROM records WHERE state = 'tombstone') AS tombstones`,
				)
				.get(),
		).toEqual({ witnesses: 0, captures: 1, tombstones: 0 });
		authorityRaw.close();
		const control = new Database(
			join(dir, 'principals', 'principal-one', 'control-v1.sqlite'),
			{ readonly: true, strict: true },
		);
		expect(
			control.query('SELECT authority_lifetime FROM active_authority').get(),
		).toEqual({ authority_lifetime: newLifetime });
		control.close();

		await runtime.close();
		runtime = createBunScalarV1Runtime({ dir });
		const reopened = await runtime.locateAuthority(principal);
		expect(
			expectOk(
				await reopened.readFacts(
					expectOk(
						parseFactsRequest({ afterSequence: 0 }, SCALAR_SYNC_V1_LIMITS),
					),
				),
			).authorityLifetime,
		).toBe(newLifetime);
		expect(
			await readdir(join(dir, 'principals', 'principal-one', 'authorities')),
		).toEqual([newLifetime]);
	} finally {
		await runtime.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('Bun Restore drains a rejected blob publication before activation', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'epicenter-restore-drain-'));
	const principal = asPrincipalId('principal-one');
	const runtime = createBunScalarV1Runtime({ dir });
	try {
		const authority = await runtime.locateAuthority(principal);
		const blobs = await runtime.locateBlobAuthority(principal);
		const backups = await runtime.locateBackupOwner(principal);
		const lifetime = expectOk(
			await authority.readFacts(
				expectOk(
					parseFactsRequest({ afterSequence: 0 }, SCALAR_SYNC_V1_LIMITS),
				),
			),
		).authorityLifetime;
		expectOk(
			await authority.submit(
				expectOk(
					parseSubmissionRequest(
						{
							authorityLifetime: lifetime,
							replicaId: REPLICA,
							submissionNumber: 1,
							intents: [{ address: LIVE, op: 'replace', value: 'portable' }],
						},
						SCALAR_SYNC_V1_LIMITS,
					),
				),
			),
		);
		const backup = await backups.create();
		let releaseUpload: () => void = () => undefined;
		const uploadHeld = new Promise<void>((resolve) => {
			releaseUpload = resolve;
		});
		const payload = new TextEncoder().encode('in-flight blob');
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(payload);
				void uploadHeld.then(() => controller.close());
			},
		});
		const acceptance = blobs.accept(
			{
				authorityLifetime: lifetime,
				address: LIVE,
				protocolVersion: BLOB_PUBLICATION_VERSION,
				digest: sha256Hex('different bytes'),
			},
			source,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		let restoreSettled = false;
		const restore = runtime
			.restoreBackup(principal, backup.backupId)
			.finally(() => {
				restoreSettled = true;
			});
		const authoritiesRoot = join(
			dir,
			'principals',
			'principal-one',
			'authorities',
		);
		for (let attempt = 0; attempt < 100; attempt += 1) {
			if ((await readdir(authoritiesRoot)).length > 1) break;
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		expect((await readdir(authoritiesRoot)).length).toBe(2);
		expect(restoreSettled).toBe(false);
		releaseUpload();
		await expect(acceptance).rejects.toThrow(
			'blob publication bytes do not match their digest',
		);
		const restored = await restore;
		expect(restored.authorityLifetime).not.toBe(lifetime);
		expect(await blobs.read(LIVE)).toBeUndefined();
	} finally {
		await runtime.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('Bun Restore replaces only the selected principal document sockets', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'epicenter-restore-sockets-'));
	const principalA = asPrincipalId('principal-a');
	const principalB = asPrincipalId('principal-b');
	const runtime = createBunScalarV1Runtime({ dir });
	try {
		async function prepare(principal: typeof principalA) {
			const authority = await runtime.locateAuthority(principal);
			const lifetime = expectOk(
				await authority.readFacts(
					expectOk(
						parseFactsRequest({ afterSequence: 0 }, SCALAR_SYNC_V1_LIMITS),
					),
				),
			).authorityLifetime;
			expectOk(
				await authority.submit(
					expectOk(
						parseSubmissionRequest(
							{
								authorityLifetime: lifetime,
								replicaId: REPLICA,
								submissionNumber: 1,
								intents: [{ address: LIVE, op: 'replace', value: principal }],
							},
							SCALAR_SYNC_V1_LIMITS,
						),
					),
				),
			);
			return { authority, lifetime };
		}
		const a = await prepare(principalA);
		const b = await prepare(principalB);
		const backup = await (await runtime.locateBackupOwner(principalA)).create();
		function fakeSocket(
			principalId: typeof principalA,
			lifetime: string,
			throwOnClose = false,
		) {
			const sent: Uint8Array[] = [];
			const closed: { code?: number; reason?: string }[] = [];
			const socket = {
				data: {
					surface: 'epicenter-data-document',
					principalId,
					address: LIVE,
					authorityLifetime: lifetime,
					authorizationExpiresAt: Date.now() + 60_000,
				},
				send(data: Uint8Array) {
					sent.push(new Uint8Array(data));
				},
				close(code?: number, reason?: string) {
					closed.push({ code, reason });
					if (throwOnClose) throw new Error('transport close failed');
				},
			} as unknown as ServerWebSocket<BunDataDocumentV1SocketData>;
			return { socket, sent, closed };
		}
		const socketA = fakeSocket(principalA, a.lifetime, true);
		const socketB = fakeSocket(principalB, b.lifetime, true);
		const empty = new Y.Doc({ gc: true });
		const frame = Buffer.from(
			encodeDocumentFrame({
				kind: 'sync-request',
				stateVector: Y.encodeStateVector(empty),
			}),
		);
		empty.destroy();
		runtime.websocket.open?.(socketA.socket);
		runtime.websocket.open?.(socketB.socket);
		runtime.websocket.message?.(socketA.socket, frame);
		runtime.websocket.message?.(socketB.socket, frame);
		expect(socketA.sent.length).toBeGreaterThan(0);
		expect(socketB.sent.length).toBeGreaterThan(0);
		const sentBeforeRestore = socketB.sent.length;

		const restored = await runtime.restoreBackup(principalA, backup.backupId);
		expect(socketA.closed).toEqual([
			{ code: 1012, reason: 'authority-replaced' },
		]);
		expect(socketB.closed).toEqual([]);
		runtime.websocket.message?.(socketB.socket, frame);
		expect(socketB.sent.length).toBeGreaterThan(sentBeforeRestore);

		runtime.websocket.close?.(socketA.socket, 1012, 'authority-replaced');
		const stale = fakeSocket(principalA, a.lifetime);
		runtime.websocket.open?.(stale.socket);
		expect(stale.closed).toEqual([
			{ code: 1012, reason: 'authority-replaced' },
		]);
		const reconnected = fakeSocket(principalA, restored.authorityLifetime);
		runtime.websocket.open?.(reconnected.socket);
		runtime.websocket.message?.(reconnected.socket, frame);
		expect(reconnected.closed).toEqual([]);
		expect(reconnected.sent.length).toBeGreaterThan(0);
	} finally {
		await runtime.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('Bun runtime excludes a second live owner of the same principal', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'epicenter-runtime-owner-'));
	const principal = asPrincipalId('principal-one');
	const first = createBunScalarV1Runtime({ dir });
	const second = createBunScalarV1Runtime({ dir });
	let reopened: ReturnType<typeof createBunScalarV1Runtime> | undefined;
	try {
		await first.locateAuthority(principal);
		await expect(second.locateAuthority(principal)).rejects.toThrow(
			'principal is already owned',
		);
		await second.close().catch(() => undefined);
		await first.close();
		reopened = createBunScalarV1Runtime({ dir });
		expect(
			expectOk(
				await (await reopened.locateAuthority(principal)).readFacts(
					expectOk(
						parseFactsRequest({ afterSequence: 0 }, SCALAR_SYNC_V1_LIMITS),
					),
				),
			).facts,
		).toEqual([]);
	} finally {
		await first.close().catch(() => undefined);
		await second.close().catch(() => undefined);
		await reopened?.close().catch(() => undefined);
		rmSync(dir, { recursive: true, force: true });
	}
});

test('Bun runtime recovers one unambiguous authority but refuses multiple candidates', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'epicenter-missing-pointer-'));
	const principal = asPrincipalId('principal-one');
	let runtime = createBunScalarV1Runtime({ dir });
	try {
		const lifetime = expectOk(
			await (await runtime.locateAuthority(principal)).readFacts(
				expectOk(
					parseFactsRequest({ afterSequence: 0 }, SCALAR_SYNC_V1_LIMITS),
				),
			),
		).authorityLifetime;
		await runtime.close();
		let control = new Database(
			join(dir, 'principals', 'principal-one', 'control-v1.sqlite'),
			{ strict: true },
		);
		control.run('DELETE FROM active_authority');
		control.close();
		runtime = createBunScalarV1Runtime({ dir });
		expect(
			expectOk(
				await (await runtime.locateAuthority(principal)).readFacts(
					expectOk(
						parseFactsRequest({ afterSequence: 0 }, SCALAR_SYNC_V1_LIMITS),
					),
				),
			).authorityLifetime,
		).toBe(lifetime);
		await runtime.close();
		control = new Database(
			join(dir, 'principals', 'principal-one', 'control-v1.sqlite'),
			{ strict: true },
		);
		control.run('DELETE FROM active_authority');
		control.close();
		await mkdir(
			join(
				dir,
				'principals',
				'principal-one',
				'authorities',
				'44444444-4444-4444-8444-444444444444',
			),
		);
		runtime = createBunScalarV1Runtime({ dir });
		await expect(runtime.locateAuthority(principal)).rejects.toThrow(
			'pointer is ambiguous for existing authority data',
		);
		expect(
			await readdir(join(dir, 'principals', 'principal-one', 'authorities')),
		).toHaveLength(2);
	} finally {
		await runtime.close().catch(() => undefined);
		rmSync(dir, { recursive: true, force: true });
	}
});
