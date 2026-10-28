/**
 * A WebSocket gate in front of the repository server: it passes frames both
 * ways until it is shut, then drops its connections and refuses new ones, so
 * a test can take one browser profile offline while the others stay on. It
 * can also lose one reply: the server answers, and the gate drops the
 * connection instead of passing the answer on.
 */
export function startGate(upstream: string) {
	let open = true;
	let dropReply = false;
	type Data = { target: string; upstream?: WebSocket; buffered: (string | Buffer)[] };
	const clients = new Set<Bun.ServerWebSocket<Data>>();
	const server = Bun.serve<Data>({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request, server) {
			if (!open) return new Response('The gate is shut', { status: 503 });
			const target = new URL(upstream);
			target.search = new URL(request.url).search;
			if (server.upgrade(request, { data: { target: target.href, buffered: [] } })) return undefined;
			return new Response('Expected a WebSocket upgrade', { status: 426 });
		},
		websocket: {
			open(client) {
				clients.add(client);
				const socket = new WebSocket(client.data.target);
				client.data.upstream = socket;
				socket.onopen = () => {
					for (const frame of client.data.buffered.splice(0)) socket.send(frame);
				};
				socket.onmessage = (event) => {
					const frame = String(event.data);
					if (dropReply && (JSON.parse(frame) as { type: string }).type === 'reply') {
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
		url: `ws://127.0.0.1:${server.port}/`,
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
