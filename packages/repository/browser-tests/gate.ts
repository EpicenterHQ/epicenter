/**
 * A gate in front of the repository server: it passes WebSocket frames both
 * ways and HTTP requests through until it is shut, then drops its
 * connections and refuses everything, so a test can take one browser
 * profile offline while the others stay on. It can also lose one reply: the
 * server answers, and the gate drops the connection instead of passing the
 * answer on. `upstream` is the server's base URL, `ws:` or `http:`.
 */
export function startGate(upstream: string) {
	const sockets = new URL(upstream);
	sockets.protocol = sockets.protocol.replace(/^http/, 'ws');
	const requests = new URL(upstream);
	requests.protocol = requests.protocol.replace(/^ws/, 'http');
	let open = true;
	let dropReply = false;
	type Data = {
		target: string;
		upstream?: WebSocket;
		buffered: (string | Buffer)[];
	};
	const clients = new Set<Bun.ServerWebSocket<Data>>();
	const server = Bun.serve<Data>({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request, server) {
			if (!open) return new Response('The gate is shut', { status: 503 });
			const { pathname, search } = new URL(request.url);
			if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
				const target = new URL(`${pathname}${search}`, sockets);
				if (
					server.upgrade(request, {
						data: { target: target.href, buffered: [] },
					})
				)
					return undefined;
				return new Response('Expected a WebSocket upgrade', { status: 426 });
			}
			const headers = new Headers(request.headers);
			headers.delete('host');
			const body =
				request.method === 'GET' || request.method === 'HEAD'
					? undefined
					: await request.arrayBuffer();
			const answered = await fetch(new URL(`${pathname}${search}`, requests), {
				method: request.method,
				headers,
				body,
			});
			return new Response(answered.body, {
				status: answered.status,
				headers: answered.headers,
			});
		},
		websocket: {
			open(client) {
				clients.add(client);
				const socket = new WebSocket(client.data.target);
				client.data.upstream = socket;
				socket.onopen = () => {
					for (const frame of client.data.buffered.splice(0))
						socket.send(frame);
				};
				socket.onmessage = (event) => {
					const frame = String(event.data);
					// The legacy server's replies are `reply`; design B's are `answer`.
					if (
						dropReply &&
						['reply', 'answer'].includes(
							(JSON.parse(frame) as { type: string }).type,
						)
					) {
						dropReply = false;
						client.close();
						return;
					}
					client.send(frame);
				};
				socket.onclose = () => client.close();
			},
			message(client, frame) {
				const socket = client.data.upstream;
				if (socket?.readyState === WebSocket.OPEN) socket.send(frame);
				else client.data.buffered.push(frame);
			},
			close(client) {
				clients.delete(client);
				client.data.upstream?.close();
			},
		},
	});
	return {
		/** The gate's base URL, in the upstream's scheme. */
		url: `${new URL(upstream).protocol}//127.0.0.1:${server.port}/`,
		/** Shut drops every connection through the gate; open lets devices reconnect. */
		setOpen(value: boolean) {
			open = value;
			if (!value) for (const client of clients) client.close();
		},
		/** Drop the connection in place of the next reply the server sends. */
		dropNextReply() {
			dropReply = true;
		},
		stop: () => server.stop(true),
	};
}
