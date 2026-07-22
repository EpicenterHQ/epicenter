import { beforeAll, expect, mock, test } from 'bun:test';

import { blobFileOwner } from '@epicenter/data/blob-v1';
import type { PortableArtifactRecord } from '@epicenter/data/portable';
import { sha256Hex } from '@epicenter/data/protocol/v1';

import {
	PORTABLE_MATERIALIZER_ADDRESS_HEADERS,
	PORTABLE_MATERIALIZER_PATHS,
} from './portable-materializer-contract-v1.js';
import {
	decodePortableMaterializerRecordStream,
	encodePortableMaterializerRecordFrame,
} from './portable-record-stream-v1.js';

mock.module('cloudflare:workers', () => ({
	DurableObject: class<Env> {
		protected ctx: DurableObjectState;
		protected env: Env;

		constructor(ctx: DurableObjectState, env: Env) {
			this.ctx = ctx;
			this.env = env;
		}
	},
	WorkerEntrypoint: class {},
}));

let handlePortableMaterializerOutbound: typeof import('./portable-materializer-container.js').handlePortableMaterializerOutbound;
let PortableMaterializer: typeof import('./portable-materializer-container.js').PortableMaterializer;

beforeAll(async () => {
	({ handlePortableMaterializerOutbound, PortableMaterializer } = await import(
		'./portable-materializer-container.js'
	));
});

const OWNER = 'owner-storage-key';
const BACKUP_ID = 'b'.repeat(24);
const ADDRESS = {
	namespace: 'so.epicenter.notes',
	collection: 'notes',
	recordKey: 'a'.repeat(24),
};
const BYTES = 'portable blob';
const DIGEST = sha256Hex(BYTES);
const RECORD: PortableArtifactRecord = {
	address: ADDRESS,
	scalar: { state: 'live', payload: { title: 'portable' } },
	documentUpdateV2: null,
	blobSha256: DIGEST,
};

function setup() {
	let expected = -1;
	let sealed = false;
	let destroyed = false;
	const imported: PortableArtifactRecord[] = [];
	let blob = '';
	const backup = {
		async initialize(recordCount: number) {
			expected = recordCount;
		},
		async importRecords(bytes: ReadableStream<Uint8Array>) {
			for await (const page of decodePortableMaterializerRecordStream(bytes)) {
				imported.push(...page);
			}
			return imported.length;
		},
		async putBlob(
			address: typeof ADDRESS,
			digest: string,
			bytes: ReadableStream<Uint8Array>,
		) {
			expect(address).toEqual(ADDRESS);
			expect(digest).toBe(DIGEST);
			blob = await new Response(bytes).text();
		},
		async seal() {
			if (imported.length !== expected) throw new Error('incomplete');
			sealed = true;
			return {
				version: 1 as const,
				state: 'sealed' as const,
				recordCount: expected,
			};
		},
		async status() {
			return sealed
				? { state: 'sealed' as const, recordCount: expected }
				: { state: 'building' as const, expectedRecordCount: expected };
		},
		async openRecordStream() {
			return new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encodePortableMaterializerRecordFrame([RECORD]));
					controller.close();
				},
			});
		},
		async openBlob() {
			return {
				bytes: new Blob([BYTES]).stream(),
				byteLength: BYTES.length,
			};
		},
		async destroy() {
			destroyed = true;
		},
	};
	const env = {
		DATA_BACKUP: { getByName: () => backup },
	} as unknown as Parameters<typeof handlePortableMaterializerOutbound>[1];
	return {
		env,
		imported,
		backup,
		get expected() {
			return expected;
		},
		get sealed() {
			return sealed;
		},
		get destroyed() {
			return destroyed;
		},
		get blob() {
			return blob;
		},
	};
}

function context(mode: 'export' | 'import') {
	return {
		containerId: 'container',
		className: 'PortableMaterializer',
		params: { ownerStorageKey: OWNER, backupId: BACKUP_ID, mode },
	} as Parameters<typeof handlePortableMaterializerOutbound>[2];
}

function blobHeaders(): Headers {
	return new Headers({
		[PORTABLE_MATERIALIZER_ADDRESS_HEADERS.namespace]: encodeURIComponent(
			ADDRESS.namespace,
		),
		[PORTABLE_MATERIALIZER_ADDRESS_HEADERS.collection]: encodeURIComponent(
			ADDRESS.collection,
		),
		[PORTABLE_MATERIALIZER_ADDRESS_HEADERS.recordKey]: encodeURIComponent(
			ADDRESS.recordKey,
		),
	});
}

test('Container outbound boundary streams one sealed Backup', async () => {
	const state = setup();
	const records = await handlePortableMaterializerOutbound(
		new Request(
			`http://epicenter.internal${PORTABLE_MATERIALIZER_PATHS.records}`,
		),
		state.env,
		context('export'),
	);
	const decoded: PortableArtifactRecord[] = [];
	if (records.body === null) throw new Error('record stream missing');
	for await (const page of decodePortableMaterializerRecordStream(
		records.body,
	)) {
		decoded.push(...page);
	}
	expect(decoded).toEqual([RECORD]);

	const owner = blobFileOwner(ADDRESS, DIGEST);
	const response = await handlePortableMaterializerOutbound(
		new Request(
			`http://epicenter.internal/blobs/${owner.ownerKey}/${owner.digest}`,
			{ headers: blobHeaders() },
		),
		state.env,
		context('export'),
	);
	expect(response.headers.get('content-length')).toBe(String(BYTES.length));
	expect(await response.text()).toBe(BYTES);
});

test('Container outbound boundary constructs and abandons an imported Backup', async () => {
	const state = setup();
	await handlePortableMaterializerOutbound(
		new Request(
			`http://epicenter.internal${PORTABLE_MATERIALIZER_PATHS.importBegin}`,
			{ method: 'POST', body: JSON.stringify({ recordCount: 1 }) },
		),
		state.env,
		context('import'),
	);
	await handlePortableMaterializerOutbound(
		new Request(
			`http://epicenter.internal${PORTABLE_MATERIALIZER_PATHS.importRecords}`,
			{
				method: 'POST',
				body: Uint8Array.from(encodePortableMaterializerRecordFrame([RECORD]))
					.buffer,
			},
		),
		state.env,
		context('import'),
	);
	const owner = blobFileOwner(ADDRESS, DIGEST);
	await handlePortableMaterializerOutbound(
		new Request(
			`http://epicenter.internal${PORTABLE_MATERIALIZER_PATHS.importBlobs}/${owner.ownerKey}/${owner.digest}`,
			{ method: 'PUT', headers: blobHeaders(), body: BYTES },
		),
		state.env,
		context('import'),
	);
	const sealed = await handlePortableMaterializerOutbound(
		new Request(
			`http://epicenter.internal${PORTABLE_MATERIALIZER_PATHS.importSeal}`,
			{ method: 'POST' },
		),
		state.env,
		context('import'),
	);
	expect((await sealed.json()) as unknown).toEqual({ recordCount: 1 });
	expect(state.imported).toEqual([RECORD]);
	expect(state.blob).toBe(BYTES);
	expect(state.sealed).toBe(true);

	await handlePortableMaterializerOutbound(
		new Request(
			`http://epicenter.internal${PORTABLE_MATERIALIZER_PATHS.import}`,
			{
				method: 'DELETE',
			},
		),
		state.env,
		context('import'),
	);
	expect(state.destroyed).toBe(true);
});

test('Container outbound boundary refuses mode and blob-owner confusion', async () => {
	const state = setup();
	await expect(
		handlePortableMaterializerOutbound(
			new Request(
				`http://epicenter.internal${PORTABLE_MATERIALIZER_PATHS.records}`,
			),
			state.env,
			context('import'),
		),
	).rejects.toThrow('does not match');
	await expect(
		handlePortableMaterializerOutbound(
			new Request(
				`http://epicenter.internal/blobs/${'f'.repeat(64)}/${DIGEST}`,
				{
					headers: blobHeaders(),
				},
			),
			state.env,
			context('export'),
		),
	).rejects.toThrow('owner is not recognized');
});

test('Container reports invalid portable bytes without hiding internal failures', async () => {
	const materializer = Object.create(
		PortableMaterializer.prototype,
	) as InstanceType<typeof PortableMaterializer>;
	Object.defineProperty(materializer, 'select', {
		value: async () => undefined,
	});
	Object.defineProperty(materializer, 'containerFetch', {
		configurable: true,
		value: async () =>
			Response.json({ error: 'invalid-portable-backup' }, { status: 400 }),
	});
	expect(
		await materializer.materializeUpload({
			ownerStorageKey: OWNER,
			backupId: BACKUP_ID,
			bytes: new Blob(['invalid']).stream(),
		}),
	).toEqual({ invalidPortableBackup: true });

	Object.defineProperty(materializer, 'containerFetch', {
		configurable: true,
		value: async () => new Response(null, { status: 503 }),
	});
	await expect(
		materializer.materializeUpload({
			ownerStorageKey: OWNER,
			backupId: BACKUP_ID,
			bytes: new Blob(['retry']).stream(),
		}),
	).rejects.toThrow('import failed (503)');
});
