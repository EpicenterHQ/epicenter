import { Hono } from 'hono';
import type {
	AiCatalog,
	AiCatalogCommand,
	AiCatalogInput,
} from './ai-catalog.js';

/** Mount behind the host's browser-session and mutation-Origin checks. */
export function createAiCatalogRoutes(catalog: AiCatalog) {
	const routes = new Hono();
	routes.onError((_error, context) =>
		context.json({ error: 'AI catalog request failed.' }, 400),
	);
	routes.get('/connections', (context) => context.json(catalog.getAll()));
	routes.post('/connections', async (context) => {
		const command = await context.req.json<AiCatalogCommand>();
		return context.json(await catalog.execute(command));
	});
	routes.get('/events', (context) => {
		let stop: (() => void) | undefined;
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		const encoder = new TextEncoder();
		let cleanup = () => {};
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				let ended = false;
				cleanup = () => {
					if (ended) return;
					ended = true;
					stop?.();
					clearInterval(heartbeat);
					catalog.signal.removeEventListener('abort', finish);
					context.req.raw.signal.removeEventListener('abort', finish);
				};
				function finish() {
					cleanup();
					controller.close();
				}
				stop = catalog.subscribe((snapshot) =>
					controller.enqueue(
						encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`),
					),
				);
				heartbeat = setInterval(
					() => controller.enqueue(encoder.encode(': keepalive\n\n')),
					// Bun defaults to a ten-second HTTP idle timeout.
					5_000,
				);
				catalog.signal.addEventListener('abort', finish, { once: true });
				context.req.raw.signal.addEventListener('abort', finish, {
					once: true,
				});
				if (catalog.signal.aborted || context.req.raw.signal.aborted) finish();
			},
			cancel() {
				cleanup();
			},
		});
		return new Response(body, {
			headers: {
				'content-type': 'text/event-stream',
				'cache-control': 'no-store',
				'x-accel-buffering': 'no',
			},
		});
	});
	routes.all('/inference/:id/:accessVersion/*', (context) => {
		const id = context.req.param('id');
		const accessVersion = context.req.param('accessVersion');
		const url = new URL(context.req.url);
		const marker = `/inference/${encodeURIComponent(id)}/${encodeURIComponent(accessVersion)}/`;
		const index = url.pathname.lastIndexOf(marker);
		if (index === -1)
			return context.json({ error: 'Invalid AI request path.' }, 400);
		const suffix = url.pathname.slice(index + marker.length) + url.search;
		return catalog.proxy(id, accessVersion, context.req.raw, suffix);
	});
	routes.post('/preview', async (context) =>
		catalog.preview(
			await context.req.json<AiCatalogInput>(),
			context.req.raw.signal,
		),
	);
	return routes;
}
