import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { AppServerClient } from './app-server-client.js';
import { AppServerError } from './app-server-client.js';
import { createAuth } from './auth.js';
import {
	BusyError,
	type CodexService,
	OutcomeUnknownError,
	ReplyConflictError,
	ThreadInUseError,
	ValidationError,
} from './codex-service.js';
import type { Config } from './config.js';
import { MAX_AUDIO_BYTES, type Transcriber } from './transcribe.js';

const securityHeaders = {
	'Cache-Control': 'no-store',
	'Referrer-Policy': 'no-referrer',
	'X-Content-Type-Options': 'nosniff',
};
const csp =
	"default-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'";
async function readBody(request: Request, limit: number) {
	const length = Number(request.headers.get('content-length'));
	if (length > limit)
		throw new ValidationError('Request body is too large', 413);
	const reader = request.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.length;
			if (size > limit) {
				await reader.cancel();
				throw new ValidationError('Request body is too large', 413);
			}
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return bytes;
}
async function readJson(request: Request): Promise<Record<string, unknown>> {
	if (
		!request.headers
			.get('content-type')
			?.toLowerCase()
			.startsWith('application/json')
	)
		throw new ValidationError('Expected application/json', 415);
	try {
		const value: unknown = JSON.parse(
			new TextDecoder().decode(await readBody(request, 100_000)),
		);
		if (!value || typeof value !== 'object' || Array.isArray(value))
			throw new ValidationError('Expected a JSON object');
		return value as Record<string, unknown>;
	} catch (error) {
		if (error instanceof ValidationError) throw error;
		throw new ValidationError('Invalid JSON');
	}
}
export function createHandler({
	config,
	client,
	service,
	transcriber,
}: {
	config: Config;
	client: AppServerClient;
	service: CodexService;
	transcriber: Transcriber;
}) {
	const auth = createAuth({ token: config.token });
	return async (
		request: Request,
		server?: { requestIP: (request: Request) => { address: string } | null },
	): Promise<Response> => {
		const url = new URL(request.url);
		const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
		const headers = new Headers(securityHeaders);
		const origin = request.headers.get('origin');
		const isAllowed = !!origin && config.allowedOrigins.includes(origin);
		if (isApi) headers.set('Vary', 'Origin');
		if (isApi && isAllowed) {
			headers.set('Access-Control-Allow-Origin', origin);
			headers.set(
				'Access-Control-Allow-Headers',
				'authorization, content-type',
			);
			headers.set('Access-Control-Allow-Methods', 'GET,POST');
		}
		const json = (value: unknown, status = 200) =>
			Response.json(value, { status, headers });
		try {
			// WHATWG URLs normalize literal dot segments before routing. Inspect the raw path too.
			const rawPath =
				request.url.replace(/^[a-z]+:\/\/[^/]+/i, '').split(/[?#]/)[0] ?? '/';
			const decoded = decodeURIComponent(rawPath);
			if (
				decoded.includes('\\') ||
				decoded.includes('\0') ||
				decoded.split('/').some((part) => part === '..' || part === '.')
			)
				return json({ error: 'Invalid path', code: 'validation' }, 400);
			if (isApi) {
				if (request.method === 'OPTIONS') {
					if (!isAllowed)
						return json(
							{ error: 'Origin is not allowed', code: 'unauthorized' },
							403,
						);
					const method = request.headers.get('access-control-request-method');
					if (method && !['GET', 'POST'].includes(method))
						return json(
							{ error: 'Method is not allowed', code: 'validation' },
							405,
						);
					return new Response(null, { status: 204, headers });
				}
				const key =
					request.headers.get('cf-connecting-ip') ??
					server?.requestIP(request)?.address ??
					'local';
				const authorized = auth.check(request, key);
				if (authorized !== 200)
					return json(
						{
							code: authorized === 429 ? 'rate_limited' : 'unauthorized',
							error:
								authorized === 429
									? 'Too many failed authentication attempts'
									: 'unauthorized',
						},
						authorized,
					);
				if (origin && !isAllowed) {
					let originHost: string;
					try {
						originHost = new URL(origin).host;
					} catch {
						return json(
							{ error: 'Origin is not allowed', code: 'unauthorized' },
							403,
						);
					}
					const requestHost = request.headers.get('host') ?? url.host;
					if (originHost !== requestHost.toLowerCase())
						return json(
							{ error: 'Origin is not allowed', code: 'unauthorized' },
							403,
						);
				}
				if (request.method === 'GET' && url.pathname === '/api/health')
					return json({
						bootId: service.bootId,
						appServer: { ...client.getState(), stderr: client.getStderr() },
						transcription: transcriber.probe(),
						policy: { sandbox: config.sandbox, approval: config.approval },
						version: '0.0.1',
					});
				if (request.method === 'GET' && url.pathname === '/api/state')
					return json(service.getState());
				if (request.method === 'GET' && url.pathname === '/api/threads')
					return json(await service.listThreads());
				if (request.method === 'POST' && url.pathname === '/api/transcribe') {
					const mime = request.headers.get('content-type') ?? '';
					if (!mime.toLowerCase().startsWith('audio/'))
						throw new ValidationError('Expected an audio content type', 415);
					if (!transcriber.probe().available)
						throw new ValidationError(
							transcriber.probe().reason ?? 'Transcription unavailable',
							503,
						);
					return json(
						await transcriber.transcribe(
							await readBody(request, MAX_AUDIO_BYTES),
							mime,
						),
					);
				}
				const turns = url.pathname.match(/^\/api\/threads\/([^/]+)\/turns$/);
				const approval = url.pathname.match(/^\/api\/approvals\/([^/]+)$/);
				const archive = url.pathname.match(
					/^\/api\/threads\/([^/]+)\/archive$/,
				);
				const id = turns?.[1] ?? approval?.[1] ?? archive?.[1];
				if (id && !/^[A-Za-z0-9_-]{1,200}$/.test(id))
					throw new ValidationError('Invalid id');
				if (archive && id && request.method === 'POST')
					return json(await service.archiveThread(id));
				if (turns && id) {
					if (request.method === 'GET') {
						const cursor = url.searchParams.get('cursor') ?? undefined;
						if (cursor && cursor.length > 10_000)
							throw new ValidationError('Invalid cursor');
						return json(await service.readTurns(id, cursor));
					}
					if (request.method === 'POST') {
						const body = await readJson(request);
						if (typeof body.text !== 'string')
							throw new ValidationError('text must be a string');
						if (
							typeof body.replyId !== 'string' ||
							!/^[A-Za-z0-9_-]{8,100}$/.test(body.replyId)
						)
							throw new ValidationError(
								'replyId must contain 8 to 100 letters, digits, underscores or hyphens',
							);
						if (body.retry !== undefined && typeof body.retry !== 'boolean')
							throw new ValidationError('retry must be a boolean');
						if (body.bootId !== undefined && typeof body.bootId !== 'string')
							throw new ValidationError('bootId must be a string');
						return json(
							await service.sendText(id, body.text, {
								replyId: body.replyId,
								retry: body.retry,
								bootId: body.bootId,
							}),
						);
					}
				}
				if (approval && id && request.method === 'POST') {
					const body = await readJson(request);
					if (body.decision !== 'accept' && body.decision !== 'decline')
						throw new ValidationError('decision must be accept or decline');
					const result = service.decideApproval(id, body.decision);
					if (result === 'changes_unavailable')
						return json(
							{
								error:
									'Codex has not shared the file changes for this request; decline it or review it in Codex',
								code: 'validation',
							},
							409,
						);
					return result
						? json({ ok: true })
						: json(
								{ error: 'Approval no longer exists', code: 'not_found' },
								404,
							);
				}
				return json({ error: 'Not found', code: 'not_found' }, 404);
			}
			if (request.method !== 'GET' && request.method !== 'HEAD')
				return json({ error: 'Method not allowed', code: 'validation' }, 405);
			const root = await realpath(config.staticDir).catch(() => null);
			if (!root)
				return new Response('Build the app first: run bun run build', {
					status: 503,
					headers: { ...securityHeaders, 'Content-Type': 'text/plain' },
				});
			const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
			if (path !== root && !path.startsWith(root + sep))
				return json({ error: 'Invalid path', code: 'validation' }, 400);
			let candidate = await realpath(path).catch(() => null);
			if (candidate && candidate !== root && !candidate.startsWith(root + sep))
				return json({ error: 'Invalid path', code: 'validation' }, 400);
			if (
				!candidate ||
				!(await Bun.file(candidate).exists()) ||
				candidate === root
			)
				candidate = await realpath(resolve(root, 'index.html')).catch(
					() => null,
				);
			if (
				!candidate?.startsWith(root + sep) ||
				!(await Bun.file(candidate).exists())
			)
				return new Response('Build the app first: run bun run build', {
					status: 503,
					headers,
				});
			const file = Bun.file(candidate);
			headers.set(
				'Cache-Control',
				url.pathname.startsWith('/_app/immutable/') &&
					!candidate.endsWith('.html')
					? 'public, max-age=31536000, immutable'
					: 'no-cache',
			);
			if (candidate.endsWith('.html'))
				headers.set('Content-Security-Policy', csp);
			return new Response(request.method === 'HEAD' ? null : file, { headers });
		} catch (error) {
			if (error instanceof ValidationError)
				return json({ error: error.message, code: 'validation' }, error.status);
			if (error instanceof BusyError)
				return json({ error: error.message, code: 'busy' }, 409);
			if (error instanceof ReplyConflictError)
				return json({ error: error.message, code: 'reply_conflict' }, 409);
			if (error instanceof OutcomeUnknownError)
				return json({ error: error.message, code: 'outcome_unknown' }, 409);
			if (error instanceof ThreadInUseError)
				return json({ error: error.message, code: 'thread_in_use' }, 409);
			if (error instanceof AppServerError)
				return json({ error: error.message, code: 'app_server' }, 502);
			if (error instanceof URIError)
				return json(
					{ error: 'Invalid path encoding', code: 'validation' },
					400,
				);
			console.error('[gateway]', error);
			return json(
				{
					error: error instanceof Error ? error.message : 'Gateway failed',
					code: 'internal',
				},
				500,
			);
		}
	};
}
