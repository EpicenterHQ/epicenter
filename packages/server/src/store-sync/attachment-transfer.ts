import { createHash } from 'node:crypto';
import {
	attachmentStorageId,
	sameAttachmentContent,
	type AttachmentContent,
} from '@epicenter/blobs';
import type { CurrentAuthority } from '@epicenter/data/sync';
import { MAX_BLOB_BYTES } from '../constants.js';
import type { S3BlobStore } from '../s3-blob-store.js';

function contentOf(value: unknown): AttachmentContent | undefined {
	if (typeof value !== 'object' || value === null) return;
	const v = value as Record<string, unknown>;
	if (
		typeof v.sha256 !== 'string' ||
		!/^[a-f0-9]{64}$/.test(v.sha256) ||
		typeof v.size !== 'number' ||
		!Number.isSafeInteger(v.size) ||
		v.size < 0 ||
		v.size > MAX_BLOB_BYTES ||
		typeof v.contentType !== 'string' ||
		!v.contentType ||
		v.contentType.length > 255 ||
		/[\r\n]/.test(v.contentType)
	)
		return;
	return { sha256: v.sha256, size: v.size, contentType: v.contentType };
}

async function readControl(request: Request) {
	const reader = request.body?.getReader();
	if (!reader) return;
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const part = await reader.read();
			if (part.done) break;
			length += part.value.length;
			if (length > 2048) {
				await reader.cancel();
				return;
			}
			chunks.push(part.value);
		}
		const bytes = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		let value: unknown;
		try {
			value = JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			return;
		}
		if (typeof value !== 'object' || value === null) return;
		const parsed = value as Record<string, unknown>;
		const content = contentOf(parsed.content);
		if (
			!content ||
			typeof parsed.generation !== 'number' ||
			!Number.isSafeInteger(parsed.generation) ||
			parsed.generation < 1
		)
			return;
		return { generation: parsed.generation, content };
	} finally {
		reader.releaseLock();
	}
}

/**
 * One authority orders verified publication against retirement. Direct PUTs may
 * leave retained bytes after retirement, but cannot publish them. No reclamation
 * is enabled here. Hashing streams outside SQLite transactions and the WebView.
 */
export function createAttachmentTransfer({
	authority,
	store,
	library,
	fetch: fetcher = globalThis.fetch,
}: {
	authority: CurrentAuthority;
	store: S3BlobStore;
	library: string;
	fetch?: typeof globalThis.fetch;
}) {
	let verifying = 0;
	return async function transfer(
		request: Request,
		tableName: string,
		rowId: string,
	): Promise<Response> {
		let id: string;
		try {
			id = attachmentStorageId(tableName, rowId);
		} catch {
			return new Response('Invalid attachment address', { status: 400 });
		}
		const key = `${library}/attachments/${tableName}/${rowId}`;
		try {
			if (request.method === 'GET') {
				const generation = Number(
					new URL(request.url).searchParams.get('generation'),
				);
				if (!Number.isSafeInteger(generation) || generation < 1)
					return new Response('Invalid generation', { status: 400 });
				const result = authority.attachments.read(generation, id);
				if (result.status !== 'published')
					return new Response(result.status, {
						status: result.status === 'retired' ? 410 : 404,
					});
				const url = await store.presignGet({ key, expiresInSeconds: 120 });
				if (authority.bind(generation).admission().error)
					return new Response('retired', { status: 410 });
				return Response.json({ url, content: result.content });
			}
			if (request.method !== 'POST' && request.method !== 'PUT')
				return new Response('Method not allowed', { status: 405 });
			const control = await readControl(request);
			if (!control)
				return new Response('Invalid attachment publication', { status: 400 });
			const { generation, content } = control;
			const existing = authority.attachments.read(generation, id);
			if (existing.status === 'retired')
				return new Response('retired', { status: 410 });
			if (existing.status === 'published') {
				if (!sameAttachmentContent(existing.content, content))
					return new Response('Attachment content differs', { status: 409 });
				// Only the retained result of actual verification makes this retry safe.
				return new Response(null, { status: 204 });
			}
			if (request.method === 'POST') {
				const ticket = await store.presignPut({
					key,
					contentType: content.contentType,
					sha256: content.sha256,
					expiresInSeconds: 300,
				});
				if (authority.bind(generation).admission().error)
					return new Response('retired', { status: 410 });
				return Response.json(ticket);
			}
			if (verifying >= 2)
				return new Response('Attachment verification busy', {
					status: 429,
					headers: { 'retry-after': '5' },
				});
			verifying++;
			const deadline = new AbortController();
			const timeout = setTimeout(() => deadline.abort(), 600_000);
			try {
				const url = await store.presignGet({ key, expiresInSeconds: 120 });
				const response = await fetcher(url, {
					signal: AbortSignal.any([request.signal, deadline.signal]),
				});
				if (!response.ok) {
					await response.body?.cancel();
					return new Response('Remote bytes unavailable', {
						status: response.status === 404 ? 404 : 502,
					});
				}
				if (response.headers.get('content-type') !== content.contentType) {
					await response.body?.cancel();
					return new Response('Attachment content differs', { status: 409 });
				}
				const reader = response.body?.getReader();
				const hash = createHash('sha256');
				let size = 0;
				try {
					while (reader) {
						const part = await reader.read();
						if (part.done) break;
						size += part.value.length;
						if (size > content.size) {
							await reader.cancel();
							return new Response('Attachment content differs', {
								status: 409,
							});
						}
						hash.update(part.value);
					}
				} finally {
					reader?.releaseLock();
				}
				if (size !== content.size || hash.digest('hex') !== content.sha256)
					return new Response('Attachment content differs', { status: 409 });
				const published = authority.attachments.publish(
					generation,
					id,
					content,
				);
				return published === 'accepted'
					? new Response(null, { status: 204 })
					: new Response(published, {
							status: published === 'retired' ? 410 : 409,
						});
			} finally {
				clearTimeout(timeout);
				verifying--;
			}
		} catch {
			return new Response('Attachment transfer failed', { status: 503 });
		}
	};
}
