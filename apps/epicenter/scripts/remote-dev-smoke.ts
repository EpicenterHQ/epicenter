/**
 * Dev-only real-device smoke for Home remote attach.
 *
 * Starts a self-host-shaped AttachRelay and a desktop Home host in one Bun
 * process, attaches the host with a minted grant, then serves a tiny phone page
 * that attaches with a second grant. This is not product UI: it is the smallest
 * way to feel the live phone -> relay -> desktop host loop on a real device.
 *
 * Run from repo root:
 *   bun run --filter @epicenter/epicenter remote:dev
 *
 * Then open the printed phone URL on a phone on the same LAN.
 */

import { mkdtempSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEngine, EngineChunk } from '@epicenter/agent';
import { createOpenAiAgentEngine } from '@epicenter/client';
import {
	createAttachRelayBunServer,
	createBunRooms,
	createDeviceGrantStore,
	createServerApp,
	mergeBunWebSocketHandlers,
	mountAttachRelayApp,
} from '@epicenter/server/bun';
import { attachHostToRelay } from '../src/attach-relay-host.ts';
import type { HomeHost } from '../src/host.ts';
import { createOwnedTestHomeHost } from '../src/test-home-host.ts';

const HOST_ID = 'dev-mac';
const PHONE_DEVICE_ID = 'phone';
const PHONE_ATTACH_ID = 'dev-phone-attach';

function createSmokeEngine(): {
	engine: AgentEngine;
	model: string;
	label: string;
} {
	const baseURL = process.env.EPICENTER_INFERENCE_URL;
	const model = process.env.EPICENTER_INFERENCE_MODEL;
	const apiKey = process.env.EPICENTER_INFERENCE_API_KEY;
	if (baseURL && model) {
		return {
			model,
			label: `${model} at ${baseURL}`,
			engine: createOpenAiAgentEngine({
				data: () => ({
					fetch: apiKey
						? (input, init) =>
								fetch(input, {
									...init,
									headers: {
										...init?.headers,
										authorization: `Bearer ${apiKey}`,
									},
								})
						: fetch,
					baseURL,
					model,
					systemPrompts: [
						'You are Epicenter Home, a local assistant that acts across the apps on this machine through their tools.',
					],
				}),
			}),
		};
	}

	return {
		model: 'remote-dev-echo',
		label:
			'echo engine (set EPICENTER_INFERENCE_URL and EPICENTER_INFERENCE_MODEL for a real model)',
		engine: async function* (): AsyncGenerator<EngineChunk> {
			yield {
				type: 'text-delta',
				delta:
					'Remote attach is connected. Set EPICENTER_INFERENCE_URL and EPICENTER_INFERENCE_MODEL to try a real model and tools.',
			};
		},
	};
}

async function main(): Promise<void> {
	const { engine, model, label } = createSmokeEngine();
	const host: HomeHost = await createOwnedTestHomeHost({
		dataDir: mkdtempSync(join(tmpdir(), 'query-remote-dev-host-')),
		engine,
		model,
	});
	const grants = createDeviceGrantStore();
	const hostGrant = await grants.mint({
		deviceId: 'desktop-host',
		label: 'Desktop host',
	});
	const phoneGrant = await grants.mint({
		deviceId: PHONE_DEVICE_ID,
		label: 'Phone dev page',
	});
	const port = Number(process.env.REMOTE_SMOKE_PORT ?? 0);

	const attachRelay = createAttachRelayBunServer();
	const bunRooms = createBunRooms({
		dir: mkdtempSync(join(tmpdir(), 'query-remote-dev-')),
	});
	const app = createServerApp({
		resolveRooms: () => bunRooms.rooms,
		identity: {
			resolveOrigin: () => `http://127.0.0.1:${port}`,
			resolveTrustedOrigins: () => [],
		},
	});
	mountAttachRelayApp(app, {
		resolveBearerPrincipal: grants.resolveBearerPrincipal,
		resolveRelay: () => attachRelay,
	});
	app.get('/', (c) => c.redirect(phonePath(phoneGrant.token)));
	app.get('/remote-dev', (c) => {
		const grant = c.req.query('grant');
		if (grant !== phoneGrant.token) return c.text('Not found', 404);
		return c.html(remoteDevPage());
	});

	const server = Bun.serve({
		hostname: '0.0.0.0',
		port,
		fetch: (req) => app.fetch(req, {} as never),
		websocket: mergeBunWebSocketHandlers({
			rooms: bunRooms.websocket,
			attach: attachRelay.websocket,
		}),
	});
	bunRooms.bindServer(server);
	attachRelay.bindServer(server);

	const relayOrigin = `ws://127.0.0.1:${server.port}`;
	const relayHost = attachHostToRelay({
		host,
		relayOrigin,
		principalId: 'instance',
		hostId: HOST_ID,
		label: 'Desktop (dev smoke)',
		bearer: hostGrant.token,
	});
	await relayHost.ready;

	const localUrl = `http://127.0.0.1:${server.port}${phonePath(phoneGrant.token)}`;
	const lanUrls = localIpAddresses().map(
		(ip) => `http://${ip}:${server.port}${phonePath(phoneGrant.token)}`,
	);

	console.log('Home remote dev smoke is running.');
	console.log(`Engine: ${label}`);
	console.log(`Host id: ${HOST_ID}`);
	console.log(`Local URL: ${localUrl}`);
	for (const url of lanUrls) console.log(`Phone URL: ${url}`);
	console.log('Press Ctrl+C to stop.');

	const shutdown = async () => {
		relayHost.close();
		await host[Symbol.asyncDispose]();
		await server.stop(true);
		process.exit(0);
	};
	process.on('SIGINT', () => void shutdown());
	process.on('SIGTERM', () => void shutdown());
}

function phonePath(grant: string): string {
	const params = new URLSearchParams({
		grant,
		hostId: HOST_ID,
		deviceId: PHONE_DEVICE_ID,
		attachId: PHONE_ATTACH_ID,
	});
	return `/remote-dev?${params}`;
}

function localIpAddresses(): string[] {
	const ips: string[] = [];
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.family === 'IPv4' && !entry.internal) ips.push(entry.address);
		}
	}
	return ips;
}

function remoteDevPage(): string {
	return String.raw`<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>Home remote dev</title>
	<style>
		:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
		body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; background: Canvas; color: CanvasText; }
		header { padding: 12px; border-bottom: 1px solid color-mix(in srgb, CanvasText 16%, transparent); display: flex; gap: 8px; align-items: center; }
		main { flex: 1; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
		.message { border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); border-radius: 12px; padding: 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
		.user { margin-left: 18%; background: color-mix(in srgb, Highlight 18%, Canvas); }
		.assistant { margin-right: 18%; }
		.tool { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; opacity: .75; }
		form { display: flex; gap: 8px; padding: 12px; border-top: 1px solid color-mix(in srgb, CanvasText 16%, transparent); }
		textarea { flex: 1; min-height: 44px; max-height: 120px; resize: vertical; font: inherit; padding: 10px; border-radius: 10px; }
		button { font: inherit; padding: 0 14px; border-radius: 10px; }
		.status { font-size: 13px; opacity: .7; }
		.approval { border-color: #d97706; }
	</style>
</head>
<body>
	<header>
		<strong>Home remote dev</strong>
		<span class="status" id="status">connecting</span>
	</header>
	<main id="messages"></main>
	<section id="approvals"></section>
	<form id="composer">
		<textarea id="input" placeholder="Ask the desktop Home host..."></textarea>
		<button>Send</button>
	</form>
	<script type="module">
		const params = new URLSearchParams(location.search);
		const grant = params.get('grant');
		const hostId = params.get('hostId') ?? 'dev-mac';
		const deviceId = params.get('deviceId') ?? 'phone';
		const attachId = params.get('attachId') ?? crypto.randomUUID();
		history.replaceState(null, '', location.pathname);

		const status = document.getElementById('status');
		const messages = document.getElementById('messages');
		const approvals = document.getElementById('approvals');
		const input = document.getElementById('input');
		const composer = document.getElementById('composer');

		if (!grant) {
			status.textContent = 'missing grant';
			throw new Error('missing grant');
		}

		const url = new URL('/attach', location.href);
		url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		url.searchParams.set('role', 'client');
		url.searchParams.set('principalId', 'instance');
		url.searchParams.set('hostId', hostId);
		url.searchParams.set('deviceId', deviceId);
		url.searchParams.set('attachId', attachId);

		const socket = new WebSocket(url, ['epicenter', 'bearer.' + grant]);
		socket.onopen = () => { status.textContent = 'connected'; };
		socket.onclose = (event) => { status.textContent = 'closed ' + event.code; };
		socket.onerror = () => { status.textContent = 'error'; };
		socket.onmessage = (event) => {
			if (typeof event.data !== 'string') return;
			let frame;
			try { frame = JSON.parse(event.data); } catch { return; }
			if (frame.type !== 'snapshot') return;
			render(frame.snapshot);
		};

		composer.addEventListener('submit', (event) => {
			event.preventDefault();
			const content = input.value.trim();
			if (!content || socket.readyState !== WebSocket.OPEN) return;
			socket.send(JSON.stringify({ type: 'send', content }));
			input.value = '';
		});

		function render(snapshot) {
			messages.replaceChildren();
			for (const message of snapshot.conversation.messages) appendMessage(message);
			if (snapshot.conversation.streaming) appendMessage(snapshot.conversation.streaming);
			if (snapshot.conversation.isThinking) appendText('assistant', 'Thinking...');
			approvals.replaceChildren(...snapshot.pendingApprovals.map(renderApproval));
			messages.scrollTop = messages.scrollHeight;
		}

		function appendMessage(message) {
			const text = message.parts.map((part) => {
				if (part.type === 'text') return part.text;
				if (part.type === 'tool-call') return '-> ' + part.toolName;
				return '<- ' + part.toolName + (part.isError ? ' [error]' : '') + '\n' + part.content;
			}).filter(Boolean).join('\n');
			appendText(message.role, text || '(empty)');
		}

		function appendText(role, text) {
			const div = document.createElement('div');
			div.className = 'message ' + (role === 'user' ? 'user' : 'assistant');
			div.textContent = text;
			messages.append(div);
		}

		function renderApproval(approval) {
			const box = document.createElement('div');
			box.className = 'message approval';
			box.innerHTML = '<strong></strong><pre></pre>';
			box.querySelector('strong').textContent = approval.title ?? approval.toolName;
			box.querySelector('pre').textContent = JSON.stringify(approval.input, null, 2);
			const approve = document.createElement('button');
			approve.textContent = 'Approve';
			approve.onclick = () => socket.send(JSON.stringify({ type: 'approve', requestId: approval.id, approved: true }));
			const deny = document.createElement('button');
			deny.textContent = 'Deny';
			deny.onclick = () => socket.send(JSON.stringify({ type: 'approve', requestId: approval.id, approved: false }));
			box.append(approve, deny);
			return box;
		}
	</script>
</body>
</html>`;
}

void main().catch((error) => {
	console.error(error);
	process.exit(1);
});
