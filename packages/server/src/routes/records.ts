import {
	parsePullRequest,
	parsePushRequest,
	parseRecordAuthorityOpenRequest,
	parseSnapshotChunkRequest,
	parseTablesApplyRequest,
	parseTablesStateRequest,
	RECORD_SYNC_ADMISSION_LIMITS,
} from '@epicenter/record-sync';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import type { Records, RecordsPartition } from '../records/contracts.js';
import type { Env } from '../types.js';
import { RecordsError } from './records-errors.js';

const RECORDS_PREFIX = '/api/records';
const RECORDS_ROUTE = `${RECORDS_PREFIX}/:workspaceId` as const;
const MAX_RECORDS_REQUEST_BYTES = 1_048_576;

async function parseJson<TValue>(
	c: { req: { raw: Request } },
	parse: (value: unknown) => TValue,
): Promise<
	{ ok: true; value: TValue } | { ok: false; reason: 'invalid' | 'too-large' }
> {
	try {
		const declaredLength = Number(c.req.raw.headers.get('content-length'));
		if (
			Number.isFinite(declaredLength) &&
			declaredLength > MAX_RECORDS_REQUEST_BYTES
		) {
			return { ok: false, reason: 'too-large' };
		}
		const text = await c.req.raw.text();
		if (new TextEncoder().encode(text).byteLength > MAX_RECORDS_REQUEST_BYTES) {
			return { ok: false, reason: 'too-large' };
		}
		return { ok: true, value: parse(JSON.parse(text)) };
	} catch {
		return { ok: false, reason: 'invalid' };
	}
}

function invalidRequest<E extends Env>(
	c: Context<E>,
	reason: 'invalid' | 'too-large',
) {
	const error =
		reason === 'too-large'
			? RecordsError.RequestTooLarge()
			: RecordsError.InvalidRequest();
	return c.json(error, error.error.status);
}

function createRecordsApp<E extends Env>(
	resolveRecords: (env: E['Bindings']) => Records,
): Hono<E> {
	const app = new Hono<E>();
	app.use(`${RECORDS_ROUTE}/*`, async (c, next) => {
		const workspaceId = c.req.param('workspaceId');
		if (
			workspaceId.length === 0 ||
			new TextEncoder().encode(workspaceId).byteLength >
				RECORD_SYNC_ADMISSION_LIMITS.identifierBytes
		) {
			return invalidRequest(c, 'invalid');
		}
		await next();
	});

	function partition(c: {
		var: Env['Variables'];
		req: { param(name: 'workspaceId'): string };
	}): RecordsPartition {
		return {
			principalId: c.var.principal.id,
			workspaceId: c.req.param('workspaceId'),
		};
	}

	return app
		.post(`${RECORDS_ROUTE}/open`, async (c) => {
			const parsed = await parseJson(c, parseRecordAuthorityOpenRequest);
			if (!parsed.ok) {
				return invalidRequest(c, parsed.reason);
			}
			const result = await resolveRecords(c.env).open(
				partition(c),
				parsed.value,
			);
			if (result.ok) {
				return c.json({
					recordsEpoch: result.recordsEpoch,
					recordsDescriptor: result.recordsDescriptor,
					recordsSchemaHash: result.recordsSchemaHash,
				});
			}
			const error = RecordsError.ProtocolMismatch();
			return c.json(error, error.error.status);
		})
		.post(`${RECORDS_ROUTE}/push`, async (c) => {
			const parsed = await parseJson(c, parsePushRequest);
			if (!parsed.ok) {
				return invalidRequest(c, parsed.reason);
			}
			return c.json(
				await resolveRecords(c.env).push(partition(c), parsed.value),
			);
		})
		.post(`${RECORDS_ROUTE}/pull`, async (c) => {
			const parsed = await parseJson(c, parsePullRequest);
			if (!parsed.ok) {
				return invalidRequest(c, parsed.reason);
			}
			return c.json(
				await resolveRecords(c.env).pull(partition(c), parsed.value),
			);
		})
		.post(`${RECORDS_ROUTE}/snapshot-chunk`, async (c) => {
			const parsed = await parseJson(c, parseSnapshotChunkRequest);
			if (!parsed.ok) {
				return invalidRequest(c, parsed.reason);
			}
			return c.json(
				await resolveRecords(c.env).snapshotChunk(partition(c), parsed.value),
			);
		})
		.post(`${RECORDS_ROUTE}/tables-state`, async (c) => {
			const parsed = await parseJson(c, parseTablesStateRequest);
			if (!parsed.ok) return invalidRequest(c, parsed.reason);
			return c.json(
				await resolveRecords(c.env).readTablesState(partition(c), parsed.value),
			);
		})
		.post(`${RECORDS_ROUTE}/tables-apply`, async (c) => {
			const parsed = await parseJson(c, parseTablesApplyRequest);
			if (!parsed.ok) return invalidRequest(c, parsed.reason);
			return c.json(
				await resolveRecords(c.env).applyTables(partition(c), parsed.value),
			);
		});
}

/** Mount the authenticated logical-record authority HTTP surface. */
export function mountRecordsApp<E extends Env = Env>(
	app: Hono<E>,
	{
		auth,
		resolveRecords,
	}: {
		auth: MiddlewareHandler<E>;
		resolveRecords: (env: E['Bindings']) => Records;
	},
): void {
	app.use(`${RECORDS_PREFIX}/*`, auth);
	app.route('/', createRecordsApp(resolveRecords));
}
