/**
 * Unmounted archive v1: complete visible stored values, reconstructed into a fresh lineage.
 * This format preserves every root, type name, attribute and formatted sequence run.
 * It excludes CRDT history and refuses subdocuments or unsupported runtime values.
 *
 * BlobStore cannot enumerate objects. Every nominal BlobId appearing anywhere in
 * stored string keys or values (including URLs and text) is therefore required.
 * This conservative v1 contract can refuse an ordinary mention of a missing blob.
 * It preserves undeclared attachments without guessing ownership from today's schema.
 *
 * The caller must durably save and read back the archive before preparing destructive
 * activation. These functions never activate, write a blob, or mutate a live document.
 * Version 1 has no migrations: unsupported versions are explicit refusals.
 */
import {
	BLOB_ID_ROUTE_REGEX,
	parseBlobId,
	type BlobId,
	type BlobNotFound,
	type BlobStoreFailed,
	type BlobStore,
} from '@epicenter/blobs';
import * as Y from '@y/y';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { type Result, tryAsync, trySync } from 'wellcrafted/result';
import type { openCurrentAuthority } from '../sync/authority.js';

type Capture = ReturnType<ReturnType<typeof openCurrentAuthority>['capture']>;

type Value =
	| ['null']
	| ['undefined']
	| ['boolean', boolean]
	| ['string', string]
	| ['number', string]
	| ['bigint', string]
	| ['binary', number[]]
	| ['array', Value[]]
	| ['object', [string, Value][]]
	| ['type', Node];
type Node = {
	name: string | null;
	attrs: [string, Value][];
	runs: { insert: ['text', string] | ['values', Value[]]; format: Value }[];
};
type Body = {
	generation: number;
	head: number;
	roots: [string, Node][];
	blobs: { id: string; contentType: string; bytes: number[] }[];
};

export const ArchiveError = defineErrors({
	InvalidArchive: ({ cause }: { cause: unknown }) => ({
		message: `Archive verification failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type ArchiveError = InferErrors<typeof ArchiveError>;

function compareNames(a: string, b: string) {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

function fail(message: string): never {
	throw new Error(message);
}
function integer(value: unknown): asserts value is number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
		fail('Expected a positive safe integer');
}
function object(value: unknown): asserts value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value))
		fail('Expected an object');
}
function keys(value: Record<string, unknown>, names: string[]) {
	const actual = Object.keys(value).sort();
	const expected = names.sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	)
		fail('Unsupported archive fields');
}
function pairs(value: unknown): [string, unknown][] {
	if (!Array.isArray(value)) fail('Expected keyed entries');
	const names = new Set<string>();
	return value.map((pair: unknown) => {
		if (
			!Array.isArray(pair) ||
			pair.length !== 2 ||
			typeof pair[0] !== 'string' ||
			names.has(pair[0])
		)
			fail('Invalid or duplicate archive key');
		names.add(pair[0]);
		return [pair[0], pair[1]];
	});
}
function byteArray(value: unknown): Uint8Array<ArrayBuffer> {
	if (
		!Array.isArray(value) ||
		value.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
	)
		fail('Invalid archive bytes');
	return new Uint8Array(value);
}

function encode(value: unknown, seen = new Set<object>()): Value {
	if (value === null) return ['null'];
	switch (typeof value) {
		case 'undefined':
			return ['undefined'];
		case 'boolean':
			return ['boolean', value];
		case 'string':
			return ['string', value];
		case 'number':
			return ['number', Object.is(value, -0) ? '-0' : String(value)];
		case 'bigint':
			return ['bigint', String(value)];
		case 'object': {
			if (seen.has(value)) fail('Cyclic stored values cannot be archived');
			seen.add(value);
			try {
				if (value instanceof Y.Type) return ['type', node(value, seen)];
				if (value instanceof Uint8Array) return ['binary', Array.from(value)];
				if (Array.isArray(value))
					return ['array', Array.from(value, (item) => encode(item, seen))];
				if (
					Object.getPrototypeOf(value) !== Object.prototype &&
					Object.getPrototypeOf(value) !== null
				)
					fail('Unsupported stored runtime value');
				if (Object.getOwnPropertySymbols(value).length > 0)
					fail('Symbol keys cannot be archived');
				return [
					'object',
					Object.entries(value)
						.sort(([a], [b]) => compareNames(a, b))
						.map(([key, item]): [string, Value] => [key, encode(item, seen)]),
				];
			} finally {
				seen.delete(value);
			}
		}
		default:
			return fail('Unsupported stored runtime value');
	}
}

function node(type: Y.Type, seen: Set<object>): Node {
	// Pinned @y/y 14.0.0-rc.24: toDelta's default renderer can be a view overlay.
	// Explicit null reads the stored visible value; shallow runs keep nested Y.Types.
	const runs: Node['runs'] = [];
	for (const operation of type.toDelta({ renderer: null }).children) {
		if (operation.type !== 'insert' || operation.attribution !== null)
			fail('Unsupported stored sequence operation');
		runs.push({
			insert:
				typeof operation.insert === 'string'
					? ['text', operation.insert]
					: [
							'values',
							operation.insert.map((item: unknown) => encode(item, seen)),
						],
			format: encode(operation.format, seen),
		});
	}
	return {
		name: type.name,
		attrs: [...type.attrEntries()]
			.map(([key, value]): [string, Value] => {
				if (typeof key !== 'string') fail('Non-string type attribute');
				return [key, encode(value, seen)];
			})
			.sort(([a], [b]) => compareNames(a, b)),
		runs,
	};
}
function roots(document: Y.Doc): Body['roots'] {
	return [...document.share]
		.sort(([a], [b]) => compareNames(a, b))
		.map(([key, type]) => [key, node(type, new Set([type]))]);
}
function complete(document: Y.Doc) {
	// Both pending fields are persisted by encodeStateAsUpdateV2. Structural export
	// cannot represent their unresolved edits, so it must refuse instead of dropping them.
	if (
		document.store.pendingStructs !== null ||
		document.store.pendingDs !== null
	)
		fail('Captured document has unresolved Yjs dependencies');
	if (document.getSubdocs().size !== 0)
		fail('Subdocuments are not supported by archive v1');
}

function decode(value: unknown, depth = 0): unknown {
	if (depth > 256 || !Array.isArray(value) || typeof value[0] !== 'string')
		fail('Invalid archive value');
	const [kind, payload] = value;
	if (value.length !== (kind === 'null' || kind === 'undefined' ? 1 : 2))
		fail('Invalid archive value shape');
	switch (kind) {
		case 'null':
			return null;
		case 'undefined':
			return undefined;
		case 'boolean':
			if (typeof payload !== 'boolean') fail('Invalid boolean');
			return payload;
		case 'string':
			if (typeof payload !== 'string') fail('Invalid string');
			return payload;
		case 'number': {
			if (typeof payload !== 'string') fail('Invalid number');
			const number = payload === '-0' ? -0 : Number(payload);
			if ((Object.is(number, -0) ? '-0' : String(number)) !== payload)
				fail('Invalid number');
			return number;
		}
		case 'bigint': {
			if (typeof payload !== 'string') fail('Invalid bigint');
			const number = BigInt(payload);
			if (String(number) !== payload) fail('Invalid bigint');
			return number;
		}
		case 'binary':
			return byteArray(payload);
		case 'array':
			if (!Array.isArray(payload)) fail('Invalid array');
			return payload.map((item) => decode(item, depth + 1));
		case 'object':
			return Object.fromEntries(
				pairs(payload).map(([key, item]) => [key, decode(item, depth + 1)]),
			);
		case 'type': {
			object(payload);
			if (payload.name !== null && typeof payload.name !== 'string')
				fail('Invalid type name');
			const type = new Y.Type(payload.name);
			fill(type, payload, depth + 1);
			return type;
		}
		default:
			return fail('Unsupported archive value tag');
	}
}
function fill(type: Y.Type, value: unknown, depth = 0) {
	if (depth > 256) fail('Archive exceeds maximum nesting');
	object(value);
	keys(value, ['name', 'attrs', 'runs']);
	for (const [key, item] of pairs(value.attrs))
		type.setAttr(key, decode(item, depth + 1));
	if (!Array.isArray(value.runs)) fail('Invalid sequence');
	let position = 0;
	for (const run of value.runs) {
		object(run);
		keys(run, ['insert', 'format']);
		if (!Array.isArray(run.insert) || run.insert.length !== 2)
			fail('Invalid insert');
		const format = decode(run.format, depth + 1);
		if (format !== null) object(format);
		const [kind, payload] = run.insert;
		if (kind === 'text' && typeof payload === 'string') {
			type.insert(position, payload, format ?? undefined);
			position += payload.length;
		} else if (kind === 'values' && Array.isArray(payload)) {
			type.insert(
				position,
				payload.map((item) => decode(item, depth + 1)),
				format ?? undefined,
			);
			position += payload.length;
		} else fail('Invalid sequence insert');
	}
}

function references(value: unknown, ids = new Set<BlobId>()): Set<BlobId> {
	if (typeof value === 'string') {
		for (const match of value.matchAll(new RegExp(BLOB_ID_ROUTE_REGEX, 'g'))) {
			const id = parseBlobId(match[0]);
			if (id !== undefined) ids.add(id);
		}
	} else if (Array.isArray(value)) {
		for (const item of value) references(item, ids);
	} else if (value !== null && typeof value === 'object') {
		object(value);
		if (Array.isArray(value.runs)) {
			// Formatting divides storage runs without dividing the visible text.
			// Embedded values and nested types do divide it; never join across them.
			let text = '';
			for (const run of value.runs) {
				object(run);
				const insert = run.insert;
				if (
					Array.isArray(insert) &&
					insert[0] === 'text' &&
					typeof insert[1] === 'string'
				) {
					text += insert[1];
				} else {
					references(text, ids);
					text = '';
				}
			}
			references(text, ids);
		}
		for (const [key, item] of Object.entries(value)) {
			references(key, ids);
			references(item, ids);
		}
	}
	return ids;
}
async function digest(value: unknown) {
	const hash = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(JSON.stringify(value)),
	);
	return Array.from(new Uint8Array(hash), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('');
}

/** Capture an authority's exact snapshot and contiguous tail before reading immutable blobs. */
export async function captureArchive(
	capture: Capture,
	blobs: Pick<BlobStore, 'get'>,
): Promise<Result<Uint8Array, ArchiveError | BlobNotFound | BlobStoreFailed>> {
	const captured = trySync({
		try: () => {
			const { generation, head } = capture;
			integer(generation);
			integer(head);
			integer(capture.snapshot.position);
			if (capture.snapshot.position > head)
				fail('Snapshot exceeds captured head');
			const document = new Y.Doc();
			try {
				Y.applyUpdateV2(document, capture.snapshot.bytes);
				let position = capture.snapshot.position;
				for (const entry of capture.tail) {
					if (entry.seq !== ++position || entry.seq > head)
						fail('Captured tail is not contiguous');
					Y.applyUpdateV2(document, entry.bytes);
				}
				if (position !== head) fail('Captured tail does not cover its head');
				complete(document);
				return {
					generation,
					head,
					roots: roots(document),
					blobs: [],
				} satisfies Body;
			} finally {
				document.destroy();
			}
		},
		catch: (cause) => ArchiveError.InvalidArchive({ cause }),
	});
	if (captured.error) return captured;
	const body: Body = captured.data;
	for (const id of [...references(body.roots)].sort()) {
		const read = await blobs.get(id);
		if (read.error) return read;
		const bytes = await tryAsync({
			try: async () =>
				Array.from(new Uint8Array(await read.data.arrayBuffer())),
			catch: (cause) => ArchiveError.InvalidArchive({ cause }),
		});
		if (bytes.error) return bytes;
		body.blobs.push({ id, contentType: read.data.type, bytes: bytes.data });
	}
	return tryAsync({
		try: async () =>
			new TextEncoder().encode(
				JSON.stringify({
					format: 'epicenter-current-archive',
					version: 1,
					body,
					digest: await digest(body),
				}),
			),
		catch: (cause) => ArchiveError.InvalidArchive({ cause }),
	});
}

/** Verify saved archive bytes and a fresh reconstruction before returning activation material. */
export async function prepareArchive(bytes: Uint8Array) {
	// Parse synchronously: caller mutation during hashing cannot change this request.
	const parsed = trySync({
		try: () =>
			JSON.parse(
				new TextDecoder('utf-8', { fatal: true }).decode(bytes),
			) as unknown,
		catch: (cause) => ArchiveError.InvalidArchive({ cause }),
	});
	if (parsed.error) return parsed;
	return tryAsync({
		try: async () => {
			const envelope = parsed.data;
			object(envelope);
			keys(envelope, ['format', 'version', 'body', 'digest']);
			if (
				envelope.format !== 'epicenter-current-archive' ||
				envelope.version !== 1
			)
				fail('Unsupported archive format or version');
			const body = envelope.body;
			object(body);
			keys(body, ['generation', 'head', 'roots', 'blobs']);
			integer(body.generation);
			integer(body.head);
			if (
				typeof envelope.digest !== 'string' ||
				(await digest(body)) !== envelope.digest
			)
				fail('Archive integrity check failed');
			const required = references(body.roots);
			const seen = new Set<string>();
			if (!Array.isArray(body.blobs)) fail('Invalid archive blobs');
			const blobs = body.blobs.map((entry: unknown) => {
				object(entry);
				keys(entry, ['id', 'contentType', 'bytes']);
				const id = parseBlobId(entry.id);
				if (
					id === undefined ||
					!required.has(id) ||
					seen.has(id) ||
					typeof entry.contentType !== 'string'
				)
					fail('Invalid or duplicate archived blob');
				seen.add(id);
				const blob = new Blob([byteArray(entry.bytes)], {
					type: entry.contentType,
				});
				if (blob.type !== entry.contentType) fail('Invalid blob content type');
				return { id, blob };
			});
			if (seen.size !== required.size)
				fail('Archive is missing referenced blobs');
			const document = new Y.Doc();
			const replayed = new Y.Doc();
			try {
				document.transact(() => {
					for (const [key, value] of pairs(body.roots)) {
						object(value);
						if (value.name !== null && typeof value.name !== 'string')
							fail('Invalid root type name');
						fill(document.get(key, value.name), value);
					}
				});
				if (JSON.stringify(roots(document)) !== JSON.stringify(body.roots))
					fail('Reconstruction changed archived values');
				const bytes = Y.encodeStateAsUpdateV2(document);
				Y.applyUpdateV2(replayed, bytes);
				complete(replayed);
				if (JSON.stringify(roots(replayed)) !== JSON.stringify(body.roots))
					fail('Serialized reconstruction changed archived values');
				return {
					source: { generation: body.generation, head: body.head },
					bytes: new Uint8Array(bytes),
					blobs,
				};
			} finally {
				document.destroy();
				replayed.destroy();
			}
		},
		catch: (cause) => ArchiveError.InvalidArchive({ cause }),
	});
}
