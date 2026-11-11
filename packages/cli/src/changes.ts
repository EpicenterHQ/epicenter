/**
 * `GET /.changes/<app>`: a server-sent event stream that says `change` when
 * the app's files change, however they changed: a call, an agent or an editor
 * writing a file, a pull. A view refreshes what it shows on each one, so it
 * never asks on a timer (ADR-0661).
 *
 * An app's folder is watched only while some view listens, and a burst of
 * writes is one `change` once the folder has been quiet for 100 ms. What is
 * not the app's records is not watched: `.git`, `ui`, and `node_modules`.
 * The event names nothing; the view asks again for what it shows.
 */
import { type FSWatcher, watch } from 'node:fs';
import { isName } from '@epicenter/app';
import { chooseApps } from './home.ts';

/** How long an app's folder stays quiet before a burst of writes is one `change`. */
const QUIET_MS = 100;

/** How often an idle stream sends a comment, so a proxy in front does not close it. */
const HEARTBEAT_MS = 25_000;

/** Top-level parts of an app that are not its records. */
const UNWATCHED = new Set(['.git', 'ui', 'node_modules']);

/** Where each app's stream is, before its name. */
export const CHANGES = '/.changes/';

const encoder = new TextEncoder();

type Stream = ReadableStreamDefaultController<Uint8Array>;

type Watched = {
	/** Each open stream, with its heartbeat. */
	streams: Map<Stream, ReturnType<typeof setInterval>>;
	watcher: FSWatcher;
	quiet?: ReturnType<typeof setTimeout>;
};

/** The streams of every app a view listens to, and the watcher of each. */
export function createChanges() {
	const watched = new Map<string, Watched>();

	const send = (stream: Stream, text: string) => {
		try {
			stream.enqueue(encoder.encode(text));
		} catch {
			// The stream closed between its last event and this one.
		}
	};

	const close = (app: string) => {
		const entry = watched.get(app);
		if (!entry) return;
		watched.delete(app);
		clearTimeout(entry.quiet);
		entry.watcher.close();
		for (const [stream, heartbeat] of entry.streams) {
			clearInterval(heartbeat);
			try {
				stream.close();
			} catch {
				// Already closed.
			}
		}
	};

	/** Watch `folder` for `app`, ending every stream when the watch fails, so each view connects again. */
	const watchApp = (app: string, folder: string): Watched => {
		const entry: Watched = {
			streams: new Map(),
			watcher: watch(folder, { recursive: true }, (_, file) => {
				const top = file?.toString().split(/[/\\]/)[0];
				if (top !== undefined && UNWATCHED.has(top)) return;
				clearTimeout(entry.quiet);
				entry.quiet = setTimeout(() => {
					for (const stream of entry.streams.keys())
						send(stream, 'event: change\ndata:\n\n');
				}, QUIET_MS);
			}),
		};
		entry.watcher.on('error', () => close(app));
		return entry;
	};

	return {
		/** Answer `GET /.changes/<app>`: the app's stream, or 404 for no such app. */
		async stream(request: Request): Promise<Response> {
			let app: string;
			try {
				app = decodeURIComponent(
					new URL(request.url).pathname.slice(CHANGES.length),
				);
			} catch {
				return new Response('Not found', { status: 404 });
			}
			if (!isName(app)) return new Response('Not found', { status: 404 });
			const [found] = (await chooseApps(app)).data ?? [];
			if (!found) return new Response('Not found', { status: 404 });
			let controller!: Stream;
			const leave = () => {
				const entry = watched.get(app);
				const heartbeat = entry?.streams.get(controller);
				if (!entry || heartbeat === undefined) return;
				clearInterval(heartbeat);
				entry.streams.delete(controller);
				if (entry.streams.size === 0) close(app);
			};
			const body = new ReadableStream<Uint8Array>({
				start(stream) {
					controller = stream;
					let entry = watched.get(app);
					if (!entry) {
						entry = watchApp(app, found.realPath);
						watched.set(app, entry);
					}
					entry.streams.set(
						stream,
						setInterval(() => send(stream, ': \n\n'), HEARTBEAT_MS),
					);
					send(stream, ': listening\n\n');
					request.signal.addEventListener('abort', leave);
				},
				cancel: leave,
			});
			return new Response(body, {
				headers: {
					'content-type': 'text/event-stream',
					'cache-control': 'no-cache',
				},
			});
		},
		/** Stop every watch and end every stream. */
		close() {
			for (const app of [...watched.keys()]) close(app);
		},
	};
}
