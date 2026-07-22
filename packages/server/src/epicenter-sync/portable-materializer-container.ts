import {
	Container,
	ContainerProxy,
	type OutboundHandler,
	type OutboundHandlerContext,
} from '@cloudflare/containers';
import { blobFileOwner } from '@epicenter/data/blob-v1';
import {
	parseAddress,
	type RecordAddress,
	SCALAR_SYNC_V1_LIMITS,
} from '@epicenter/data/protocol/v1';

import { type DataBackup, dataBackupV1Name } from './cloudflare-backup-v1.js';
import {
	PORTABLE_MATERIALIZER_ADDRESS_HEADERS,
	PORTABLE_MATERIALIZER_PATHS,
} from './portable-materializer-contract-v1.js';

const INTERNAL_HOST = 'epicenter.internal';
const CONTAINER_ORIGIN = 'http://container';
const HEX_64 = /^[a-f0-9]{64}$/u;

type MaterializerBackup = Pick<
	DataBackup,
	| 'destroy'
	| 'importRecords'
	| 'initialize'
	| 'openBlob'
	| 'openRecordStream'
	| 'putBlob'
	| 'seal'
	| 'status'
>;

export type PortableMaterializerEnv = Cloudflare.Env & {
	DATA_BACKUP: {
		getByName(name: string): MaterializerBackup;
	};
};

type MaterializerJob = {
	ownerStorageKey: string;
	backupId: string;
	mode: 'export' | 'import';
};

export type PortableMaterializerUpload = {
	ownerStorageKey: string;
	backupId: string;
	bytes: ReadableStream<Uint8Array>;
};

function validateJob(raw: MaterializerJob): MaterializerJob {
	dataBackupV1Name(raw.ownerStorageKey, raw.backupId);
	if (raw.mode !== 'export' && raw.mode !== 'import') {
		throw new TypeError('portable materializer mode is not recognized');
	}
	return raw;
}

function decodeHeader(request: Request, name: string): string {
	const raw = request.headers.get(name);
	if (raw === null)
		throw new TypeError('portable materializer address is missing');
	try {
		return decodeURIComponent(raw);
	} catch {
		throw new TypeError('portable materializer address is not recognized');
	}
}

function parseBlobRequest(
	request: Request,
	prefix: string,
): {
	address: RecordAddress;
	digest: string;
} {
	const path = new URL(request.url).pathname;
	if (!path.startsWith(`${prefix}/`)) {
		throw new TypeError('portable materializer blob path is not recognized');
	}
	const [ownerKey, digest, extra] = path.slice(prefix.length + 1).split('/');
	if (
		extra !== undefined ||
		ownerKey === undefined ||
		digest === undefined ||
		!HEX_64.test(ownerKey) ||
		!HEX_64.test(digest)
	) {
		throw new TypeError('portable materializer blob path is not recognized');
	}
	const parsed = parseAddress(
		{
			namespace: decodeHeader(
				request,
				PORTABLE_MATERIALIZER_ADDRESS_HEADERS.namespace,
			),
			collection: decodeHeader(
				request,
				PORTABLE_MATERIALIZER_ADDRESS_HEADERS.collection,
			),
			recordKey: decodeHeader(
				request,
				PORTABLE_MATERIALIZER_ADDRESS_HEADERS.recordKey,
			),
		},
		SCALAR_SYNC_V1_LIMITS,
	);
	if (parsed.error !== null) throw parsed.error;
	const owner = blobFileOwner(parsed.data, digest);
	if (owner.ownerKey !== ownerKey || owner.digest !== digest) {
		throw new TypeError('portable materializer blob owner is not recognized');
	}
	return { address: parsed.data, digest };
}

function requireMode(
	job: MaterializerJob,
	mode: MaterializerJob['mode'],
): void {
	if (job.mode !== mode) {
		throw new Error('portable materializer operation does not match its job');
	}
}

export async function handlePortableMaterializerOutbound(
	request: Request,
	env: PortableMaterializerEnv,
	context: OutboundHandlerContext<MaterializerJob>,
): Promise<Response> {
	const job = validateJob(context.params);
	const backup = env.DATA_BACKUP.getByName(
		dataBackupV1Name(job.ownerStorageKey, job.backupId),
	);
	const path = new URL(request.url).pathname;

	if (
		request.method === 'GET' &&
		path === PORTABLE_MATERIALIZER_PATHS.records
	) {
		requireMode(job, 'export');
		return new Response(await backup.openRecordStream(), {
			headers: { 'content-type': 'application/x-ndjson' },
		});
	}
	if (request.method === 'GET' && path.startsWith('/blobs/')) {
		requireMode(job, 'export');
		const blob = parseBlobRequest(request, '/blobs');
		const opened = await backup.openBlob(blob.address, blob.digest);
		return new Response(opened.bytes, {
			headers: { 'content-length': String(opened.byteLength) },
		});
	}
	if (
		request.method === 'POST' &&
		path === PORTABLE_MATERIALIZER_PATHS.importBegin
	) {
		requireMode(job, 'import');
		const body: unknown = await request.json();
		if (
			body === null ||
			typeof body !== 'object' ||
			Object.keys(body).join(',') !== 'recordCount' ||
			!Number.isSafeInteger((body as { recordCount?: unknown }).recordCount) ||
			((body as { recordCount: number }).recordCount ?? -1) < 0
		) {
			throw new TypeError(
				'portable materializer record count is not recognized',
			);
		}
		await backup.initialize((body as { recordCount: number }).recordCount);
		return new Response(null, { status: 204 });
	}
	if (
		request.method === 'POST' &&
		path === PORTABLE_MATERIALIZER_PATHS.importRecords
	) {
		requireMode(job, 'import');
		if (request.body === null) {
			throw new TypeError('portable materializer record stream is missing');
		}
		const recordCount = await backup.importRecords(request.body);
		return Response.json({ recordCount });
	}
	if (
		request.method === 'PUT' &&
		path.startsWith(`${PORTABLE_MATERIALIZER_PATHS.importBlobs}/`)
	) {
		requireMode(job, 'import');
		if (request.body === null) {
			throw new TypeError('portable materializer blob stream is missing');
		}
		const blob = parseBlobRequest(
			request,
			PORTABLE_MATERIALIZER_PATHS.importBlobs,
		);
		await backup.putBlob(blob.address, blob.digest, request.body);
		return new Response(null, { status: 204 });
	}
	if (
		request.method === 'POST' &&
		path === PORTABLE_MATERIALIZER_PATHS.importSeal
	) {
		requireMode(job, 'import');
		const sealed = await backup.seal();
		return Response.json({ recordCount: sealed.recordCount });
	}
	if (
		request.method === 'DELETE' &&
		path === PORTABLE_MATERIALIZER_PATHS.import
	) {
		requireMode(job, 'import');
		await backup.destroy();
		return new Response(null, { status: 204 });
	}
	return new Response(null, { status: 404 });
}

/** Ephemeral byte transformer. Durable publication remains registry-owned. */
export class PortableMaterializer extends Container<PortableMaterializerEnv> {
	override defaultPort = 8080;
	override requiredPorts = [8080];
	override sleepAfter = '1m';
	override enableInternet = false;
	override pingEndpoint = '/health';

	static override outboundHandlers = {
		backup: handlePortableMaterializerOutbound,
	} satisfies Record<
		string,
		OutboundHandler<PortableMaterializerEnv, MaterializerJob>
	>;

	private async select(job: MaterializerJob): Promise<void> {
		validateJob(job);
		await this.setOutboundByHost(INTERNAL_HOST, 'backup', job);
	}

	async materializeUpload(
		input: PortableMaterializerUpload,
	): Promise<{ recordCount: number } | { invalidPortableBackup: true }> {
		await this.select({
			ownerStorageKey: input.ownerStorageKey,
			backupId: input.backupId,
			mode: 'import',
		});
		const response = await this.containerFetch(
			`${CONTAINER_ORIGIN}${PORTABLE_MATERIALIZER_PATHS.import}`,
			{ method: 'POST', body: input.bytes },
		);
		if (response.status === 400) {
			return { invalidPortableBackup: true };
		}
		if (!response.ok) {
			throw new Error(
				`portable materializer import failed (${response.status})`,
			);
		}
		const backup = this.env.DATA_BACKUP.getByName(
			dataBackupV1Name(input.ownerStorageKey, input.backupId),
		);
		const status = await backup.status();
		if (status.state !== 'sealed') {
			throw new Error('portable materializer did not seal its DataBackup');
		}
		return { recordCount: status.recordCount };
	}

	async downloadBackup(input: {
		ownerStorageKey: string;
		backupId: string;
	}): Promise<Response> {
		await this.select({ ...input, mode: 'export' });
		const backup = this.env.DATA_BACKUP.getByName(
			dataBackupV1Name(input.ownerStorageKey, input.backupId),
		);
		if ((await backup.status()).state !== 'sealed') {
			return new Response(null, { status: 404 });
		}
		return this.containerFetch(
			`${CONTAINER_ORIGIN}${PORTABLE_MATERIALIZER_PATHS.export}`,
			{ method: 'POST' },
		);
	}
}

export { ContainerProxy };
