import { bearerSubprotocol, MAIN_SUBPROTOCOL } from '@epicenter/sync';
import { createSessionHandoffClient } from '../src/session-handoff-client.js';

const baseURL = document.body.dataset.authOrigin;
if (!baseURL) throw new Error('Missing fixture auth origin');

function button(id: string, action: () => Promise<unknown>) {
	const output = document.querySelector('output');
	if (!output) throw new Error('Missing fixture output');
	document.getElementById(id)?.addEventListener('click', async () => {
		try {
			output.textContent = JSON.stringify(await action());
			output.dataset.status = 'ok';
		} catch (cause) {
			output.textContent = String(cause);
			output.dataset.status = 'error';
		}
	});
}

if (document.body.dataset.role === 'hosted') {
	button('authorize', async () => {
		const params = new URL(location.href).searchParams;
		const response = await fetch('/auth/session/authorize', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				callback: params.get('callback'),
				challenge: params.get('challenge'),
				state: params.get('state'),
			}),
		});
		if (!response.ok) throw new Error(`Authorize failed: ${response.status}`);
		const { url } = (await response.json()) as { url: string };
		location.assign(url);
		return { authorized: true };
	});
} else {
	// A fresh instance on every real page load; pending state belongs to sessionStorage.
	const client = createSessionHandoffClient({
		baseURL,
		callback: `${location.origin}/auth/callback`,
		storage: sessionStorage,
	});
	button('begin', async () => ({ login: (await client.begin()).href }));
	button('complete', async () => {
		const token = await client.complete(location.href);
		const response = await fetch(`${baseURL}/api/session`, {
			credentials: 'omit',
			headers: { authorization: `Bearer ${token}` },
		});
		if (!response.ok) throw new Error(`Resource failed: ${response.status}`);
		const principal = (await response.json()) as {
			principalId: string;
			email: string;
		};
		const protocol = bearerSubprotocol(token);
		const socketResult = await new Promise<{
			protocol: string;
			message: string;
		}>((resolve, reject) => {
			const socket = new WebSocket(
				`${baseURL.replace('http:', 'ws:')}/socket`,
				[MAIN_SUBPROTOCOL, protocol],
			);
			const timeout = setTimeout(() => {
				socket.close();
				reject(new Error('Socket timed out'));
			}, 5_000);
			socket.addEventListener('open', () => socket.send('browser-proof'));
			socket.addEventListener('error', () => {
				clearTimeout(timeout);
				reject(new Error('Socket failed'));
			});
			socket.addEventListener(
				'message',
				(event) => {
					clearTimeout(timeout);
					const result = {
						protocol: socket.protocol,
						message: String(event.data),
					};
					socket.addEventListener('close', () => resolve(result), {
						once: true,
					});
					socket.close(1000, 'proof complete');
				},
				{ once: true },
			);
		});
		// Report facts, never the credential itself.
		return {
			principal,
			socket: socketResult,
			encodedPadding: protocol.includes('%3D'),
		};
	});
}
