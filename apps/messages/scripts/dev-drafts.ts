/**
 * The drafts' directory under `bun dev:messages`: Vite's dev server answers
 * the page's `/folder/<verb>` requests as Messages' program does
 * (`serve.ts`), over the development drafts directory
 * (`messagesFolder('development')`), so demo drafts work while the
 * interface is developed. It answers no Beeper request: live Beeper needs
 * the program. `vite.config.ts` loads this through Vite on the first such
 * request, so loading the config loads none of it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { serveDirectory } from '@epicenter/folder/serve';
import { fromOwnPage, MESSAGES_PORT, messagesFolder } from './serve.ts';

/** The middleware answering the page's folder requests, until `closed` fires. */
export function devDrafts(closed: (stop: () => void) => void) {
	const drafts = serveDirectory(messagesFolder('development'));
	closed(() => drafts.close());
	const selves = [`localhost:${MESSAGES_PORT}`, `127.0.0.1:${MESSAGES_PORT}`];
	return async (req: IncomingMessage, res: ServerResponse) => {
		const self = selves.find((host) => host === req.headers.host);
		const request = await toRequest(req, res);
		const response =
			request.method !== 'POST'
				? new Response(null, { status: 405 })
				: self === undefined || !fromOwnPage(request, self)
					? new Response(null, { status: 403 })
					: await drafts.fetch(request);
		await send(response, res);
	};
}

/** A Node request as a Fetch API one, aborted when the page goes away. */
async function toRequest(req: IncomingMessage, res: ServerResponse) {
	const chunks: Uint8Array[] = [];
	for await (const chunk of req) chunks.push(chunk as Uint8Array);
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers))
		if (typeof value === 'string') headers.set(name, value);
	const gone = new AbortController();
	res.on('close', () => gone.abort());
	return new Request(`http://${req.headers.host}${req.url}`, {
		method: req.method,
		headers,
		body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
		signal: gone.signal,
	});
}

/** A Fetch API response written to Node's, its body streamed as it comes. */
async function send(response: Response, res: ServerResponse) {
	res.statusCode = response.status;
	response.headers.forEach((value, name) => {
		res.setHeader(name, value);
	});
	if (response.body === null) return void res.end();
	res.flushHeaders();
	const reader = response.body.getReader();
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			res.write(value);
		}
	} catch {
		// The page went away.
	}
	res.end();
}
