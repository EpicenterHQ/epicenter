import {
	parseTablesApplyResponse,
	parseTablesStateResponse,
	type RecordAuthorityOpenRequest,
	type TablesApplyRequest,
	type TablesApplyResponse,
	type TablesStateRequest,
	type TablesStateResponse,
} from '@epicenter/record-sync';
import type {
	ReplicaAuthorityOpenRequest,
	ReplicaSyncPort,
} from './replica.js';
import { ReplicaSyncRefusalError } from './replica.js';

export type CreateHttpReplicaSyncPortOptions = {
	baseUrl: string;
	/** Auth-owned fetch implementation. */
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export type TablesAuthorityPort = {
	readTablesState(
		request: TablesStateRequest,
		signal?: AbortSignal,
	): Promise<TablesStateResponse>;
	applyTables(
		request: TablesApplyRequest,
		signal?: AbortSignal,
	): Promise<TablesApplyResponse>;
};

/** Bind the record-sync HTTP routes to one workspace replica runtime. */
export function createHttpReplicaSyncPort({
	baseUrl,
	fetch,
}: CreateHttpReplicaSyncPortOptions): ReplicaSyncPort & TablesAuthorityPort {
	const origin = new URL(baseUrl);
	let workspaceId: string | undefined;

	function route(action: string): URL {
		if (!workspaceId) {
			throw new Error('Replica HTTP port is not bound to a workspace');
		}
		return new URL(
			`/api/records/${encodeURIComponent(workspaceId)}/${action}`,
			origin,
		);
	}

	async function post(
		url: URL,
		body: unknown,
		signal?: AbortSignal,
	): Promise<unknown> {
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
			signal,
		});
		const text = await response.text();
		let value: unknown;
		try {
			value = text === '' ? null : JSON.parse(text);
		} catch (cause) {
			throw new Error(`Record sync returned non-JSON HTTP ${response.status}`, {
				cause,
			});
		}
		if (!response.ok) {
			if (isProtocolMismatch(value)) {
				throw new ReplicaSyncRefusalError('protocol-mismatch');
			}
			throw new Error(`Record sync HTTP ${response.status}: ${text}`);
		}
		return value;
	}

	return {
		bindWorkspace(nextWorkspaceId) {
			if (workspaceId && workspaceId !== nextWorkspaceId) {
				throw new Error(
					'Replica HTTP port is already bound to another workspace',
				);
			}
			workspaceId = nextWorkspaceId;
		},
		async openAuthority(request, signal) {
			this.bindWorkspace(request.workspaceId);
			return post(route('open'), openRequestBody(request), signal);
		},
		push(request, signal) {
			return post(route('push'), request, signal);
		},
		pull(request, signal) {
			return post(route('pull'), request, signal);
		},
		snapshotChunk(request, signal) {
			return post(route('snapshot-chunk'), request, signal);
		},
		async readTablesState(request, signal) {
			return parseTablesStateResponse(
				await post(route('tables-state'), request, signal),
			);
		},
		async applyTables(request, signal) {
			return parseTablesApplyResponse(
				await post(route('tables-apply'), request, signal),
			);
		},
	} satisfies ReplicaSyncPort & TablesAuthorityPort;
}

function isProtocolMismatch(
	value: unknown,
): value is { error: { name: 'ProtocolMismatch' } } {
	return (
		typeof value === 'object' &&
		value !== null &&
		Object.hasOwn(value, 'error') &&
		typeof (value as { error?: unknown }).error === 'object' &&
		(value as { error: { name?: unknown } }).error !== null &&
		(value as { error: { name?: unknown } }).error.name === 'ProtocolMismatch'
	);
}

function openRequestBody({
	protocolMajor,
	recordsDescriptor,
	recordsSchemaHash,
}: ReplicaAuthorityOpenRequest): RecordAuthorityOpenRequest {
	return { protocolMajor, recordsDescriptor, recordsSchemaHash };
}
