import { Type } from 'typebox';
import { createDeviceBunWorkspaceRuntime } from './bun-runtime.js';

export { DesktopWorkspaceError } from './desktop-protocol.js';

import {
	type DesktopRecordOperation,
	type DesktopRecordRequest,
	encodeDesktopRecordResult,
	encodeDocumentBytes,
	decodeDocumentBytes,
} from './desktop-protocol.js';
import type { WorkspaceHandle } from './runtime.js';
import type { WorkspaceDefinition } from './runtime-definition.js';

const sqliteRows = Type.Record(
	Type.String(),
	Type.Union([Type.String(), Type.Number(), Type.Null()]),
);

type ErasedWorkspace = WorkspaceHandle<WorkspaceDefinition>;
type ErasedKv = {
	get(key: string): Promise<unknown>;
	set(key: string, value: unknown): Promise<unknown>;
	unset(key: string): Promise<void>;
};

/** Bun-only owner over a statically linked set of imported definitions. */
export function createDesktopWorkspaceOwner({
	workspacesRoot,
	definitions,
}: {
	workspacesRoot: string;
	definitions: readonly WorkspaceDefinition[];
}) {
	const catalog = new Map<string, WorkspaceDefinition>();
	for (const definition of definitions) {
		if (catalog.has(definition.id)) {
			throw new Error(`Duplicate desktop workspace '${definition.id}'`);
		}
		catalog.set(definition.id, definition);
	}
	const runtime = createDeviceBunWorkspaceRuntime({ workspacesRoot });
	const handles = new Map<string, Promise<ErasedWorkspace>>();
	/**
	 * The one live renderer surface per workspace. An `open` from a newer
	 * surface displaces the previous owner; the displaced surface's later
	 * requests fail with the named moved error. In-process host consumers of
	 * owner-opened handles are not surfaces and are unaffected.
	 */
	const surfaces = new Map<string, string>();

	const openRegistered = (workspaceId: string): Promise<ErasedWorkspace> => {
		const definition = catalog.get(workspaceId);
		if (!definition) {
			throw new Error(`Unknown desktop workspace '${workspaceId}'`);
		}
		let opening = handles.get(workspaceId);
		if (!opening) {
			opening = runtime.open(definition);
			handles.set(workspaceId, opening);
			void opening.catch(() => {
				if (handles.get(workspaceId) === opening) handles.delete(workspaceId);
			});
		}
		return opening;
	};

	return Object.freeze({
		async open<TDefinition extends WorkspaceDefinition>(
			definition: TDefinition,
		): Promise<WorkspaceHandle<TDefinition>> {
			if (catalog.get(definition.id) !== definition) {
				throw new Error(
					`Desktop workspace '${definition.id}' is not registered with this definition`,
				);
			}
			return (await openRegistered(
				definition.id,
			)) as WorkspaceHandle<TDefinition>;
		},
		hasWorkspace(workspaceId: string): boolean {
			return catalog.has(workspaceId);
		},
		async execute(workspaceId: string, input: unknown): Promise<unknown> {
			const { surfaceId, operation } = parseDesktopRecordRequest(input);
			const workspace = await openRegistered(workspaceId);
			if (operation.kind === 'open') {
				// Newest surface wins: opening claims the workspace and displaces
				// any previous surface. The awaited acquisition above IS the
				// handshake's work.
				surfaces.set(workspaceId, surfaceId);
				return undefined;
			}
			if (surfaces.get(workspaceId) !== surfaceId) {
				const moved = new Error(
					`Workspace '${workspaceId}' moved to a newer window`,
				);
				moved.name = 'WorkspaceStorageMovedError';
				throw moved;
			}
			if (operation.kind === 'sql') {
				return workspace.sql(operation.query, operation.parameters, sqliteRows);
			}
			if (operation.kind === 'kv-get') {
				return encodeDesktopRecordResult(
					operation,
					await (workspace.kv as unknown as ErasedKv).get(operation.key),
				);
			}
			if (operation.kind === 'kv-set') {
				return (workspace.kv as unknown as ErasedKv).set(
					operation.key,
					operation.value,
				);
			}
			if (operation.kind === 'kv-unset') {
				return (workspace.kv as unknown as ErasedKv).unset(operation.key);
			}
			if (operation.kind === 'read-current-row') {
				const table = workspace.tables[operation.table];
				if (!table) throw new Error(`Unknown table '${operation.table}'`);
				const result = await table.get(operation.rowId);
				// A projection error still proves the row exists; only a clean
				// undefined read means the address is dead.
				if (result.error === null && result.data === undefined) {
					return undefined;
				}
				return {};
			}
			if (operation.kind === 'document-load') {
				const parts = await runtime.loadDocument(workspaceId, {
					table: operation.table,
					rowId: operation.rowId,
				});
				return parts.map(encodeDocumentBytes);
			}
			if (operation.kind === 'document-append') {
				await runtime.appendDocument(
					workspaceId,
					{ table: operation.table, rowId: operation.rowId },
					decodeDocumentBytes(operation.update),
				);
				return undefined;
			}
			const table = workspace.tables[operation.table];
			if (!table) throw new Error(`Unknown table '${operation.table}'`);
			switch (operation.kind) {
				case 'get':
					return encodeDesktopRecordResult(
						operation,
						await table.get(operation.id),
					);
				case 'list':
					return table.list();
				case 'create':
					return table.create(operation.input);
				case 'update': {
					const changes: Record<string, unknown> = { ...operation.set };
					for (const name of operation.unset) changes[name] = undefined;
					return encodeDesktopRecordResult(
						operation,
						await table.update(operation.id, changes),
					);
				}
				case 'delete':
					return table.delete(operation.id);
				default:
					return operation satisfies never;
			}
		},
		async [Symbol.asyncDispose]() {
			handles.clear();
			surfaces.clear();
			await runtime[Symbol.asyncDispose]();
		},
	});
}

export type DesktopWorkspaceOwner = ReturnType<
	typeof createDesktopWorkspaceOwner
>;

function parseDesktopRecordRequest(input: unknown): DesktopRecordRequest {
	if (
		!isPlainObject(input) ||
		typeof input.surfaceId !== 'string' ||
		input.surfaceId.length === 0
	) {
		throw new TypeError('Invalid desktop record request');
	}
	return {
		surfaceId: input.surfaceId,
		operation: parseDesktopRecordOperation(input.operation),
	};
}

function parseDesktopRecordOperation(input: unknown): DesktopRecordOperation {
	if (!isPlainObject(input) || typeof input.kind !== 'string') {
		throw new TypeError('Invalid desktop record operation');
	}
	const table = typeof input.table === 'string' ? input.table : undefined;
	const id = typeof input.id === 'string' ? input.id : undefined;
	switch (input.kind) {
		case 'open':
			return { kind: 'open' };
		case 'kv-get':
		case 'kv-unset':
			if (typeof input.key !== 'string') break;
			return { kind: input.kind, key: input.key };
		case 'kv-set':
			if (typeof input.key !== 'string' || !('value' in input)) break;
			return { kind: 'kv-set', key: input.key, value: input.value };
		case 'read-current-row':
		case 'document-load':
			if (!table || typeof input.rowId !== 'string') break;
			return { kind: input.kind, table, rowId: input.rowId };
		case 'document-append':
			if (
				!table ||
				typeof input.rowId !== 'string' ||
				typeof input.update !== 'string'
			)
				break;
			return {
				kind: 'document-append',
				table,
				rowId: input.rowId,
				update: input.update,
			};
		case 'get':
		case 'delete':
			if (!table || !id) break;
			return { kind: input.kind, table, id };
		case 'list':
			if (!table) break;
			return { kind: 'list', table };
		case 'create':
			if (!table || !isPlainObject(input.input)) break;
			return { kind: 'create', table, input: input.input };
		case 'update':
			if (
				!table ||
				!id ||
				!isPlainObject(input.set) ||
				!Array.isArray(input.unset) ||
				!input.unset.every((name) => typeof name === 'string')
			) {
				break;
			}
			return {
				kind: 'update',
				table,
				id,
				set: input.set,
				unset: input.unset,
			};
		case 'sql':
			if (
				typeof input.query !== 'string' ||
				!Array.isArray(input.parameters) ||
				!input.parameters.every(
					(value) =>
						value === null ||
						typeof value === 'string' ||
						typeof value === 'number',
				)
			) {
				break;
			}
			return {
				kind: 'sql',
				query: input.query,
				parameters: input.parameters,
			};
	}
	throw new TypeError('Invalid desktop record operation');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
