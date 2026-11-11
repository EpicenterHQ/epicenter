/**
 * Connectors as `serve` runs them, with real apps, and `epicenter access`
 * beside it. Runs the real CLI against a temporary HOME whose `EPICENTER.md`
 * has a `connectors` block.
 *
 * Claude's authorize request runs in this test process, on the same
 * `access.local.sqlite` that `serve` holds open, through the public handler
 * with a stubbed CIMD fetch: serve's own fetch would go to claude.ai. The
 * approval then goes to serve's real private listener at `/.allow`, and the
 * tokens it yields are used against serve's public port. The public address
 * is `https://localhost:9`, where nothing listens.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openAuthorizationServer } from './authorization-server.ts';
import {
	answerAllow,
	authorizeQuery,
	CLAUDE_ID,
	claudeOnly,
	connectClaude,
	mcpRequest,
	reachAllow,
	refresh,
	type Send,
	type Sides,
} from './connectors.test-support.ts';
import { publicHandler } from './public.ts';
import { fixture, gitIn, readingApp } from './runner.test-support.ts';

setDefaultTimeout(60_000);

const ORIGIN = 'https://localhost:9';
const TAILNET = 'https://studio.tailnet.ts.net:4747';
const MARKER = `---\nport: 4747\nconnectors:\n  url: ${ORIGIN}\n  port: 0\n  tailnet: ${TAILNET}\n---\n`;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Start `serve` and wait for both of its listeners. */
async function serve(f: Awaited<ReturnType<typeof fixture>>) {
	const child = Bun.spawn([process.execPath, f.bin, 'serve', '--port', '0'], {
		cwd: f.root,
		env: f.env,
		stdout: 'ignore',
		stderr: 'pipe',
	});
	const ready = Promise.withResolvers<{ local: string; public: string }>();
	let output = '';
	void (async () => {
		const reader = child.stderr.getReader();
		for (;;) {
			const { value: chunk, done } = await reader.read();
			if (done) break;
			output += new TextDecoder().decode(chunk);
			const local = /Serving your apps at (http:\/\/127\.0\.0\.1:\d+)\./.exec(
				output,
			)?.[1];
			const open = / from (http:\/\/127\.0\.0\.1:\d+): an HTTPS tunnel/.exec(
				output,
			)?.[1];
			if (local && open) ready.resolve({ local, public: open });
		}
		ready.reject(new Error(output || 'serve exited before listening'));
	})();
	cleanups.push(async () => {
		child.kill('SIGTERM');
		await child.exited;
	});
	const bases = await Promise.race([
		ready.promise,
		Bun.sleep(15_000).then(() => {
			throw new Error(`serve did not listen: ${output}`);
		}),
	]);
	return { ...bases, stderr: () => output };
}

/** A fixture whose Epicenter takes connectors, `reading` in it, and serve running. */
async function setup() {
	const f = await fixture();
	await writeFile(join(f.home, 'EPICENTER.md'), MARKER);
	const reading = await f.folder(join(f.home, 'reading'), readingApp);
	const served = await serve(f);
	cleanups.push(() => rm(f.root, { recursive: true, force: true }));
	// This process's own view of the same server, for Claude's authorize.
	const authorization = await openAuthorizationServer(
		f.home,
		{ url: ORIGIN, port: 0, tailnet: TAILNET },
		claudeOnly(),
	);
	cleanups.unshift(async () => authorization.close());
	const inProcess = publicHandler(authorization, async () => {
		throw new Error("Claude's authorize never reaches the site");
	});
	/** Claude's authorize and token calls, in this process. */
	const send: Send = (request) => inProcess(request);
	/** A request to serve's public listener, as the tunnel delivers it. */
	const toPublic: Send = async (request) => {
		const { pathname, search } = new URL(request.url);
		return fetch(`${served.public}${pathname}${search}`, {
			method: request.method,
			headers: request.headers,
			body: request.method === 'GET' ? undefined : await request.text(),
			redirect: 'manual',
		});
	};
	/**
	 * A request to the approval page, delivered to serve's private listener
	 * as `tailscale serve` would, naming the tailnet host it was sent to.
	 */
	const tailnetSend: Send = async (request) => {
		const { pathname, search } = new URL(request.url);
		const headers = new Headers(request.headers);
		headers.set('host', new URL(TAILNET).host);
		return fetch(`${served.local}${pathname}${search}`, {
			method: request.method,
			headers,
			body: request.method === 'GET' ? undefined : await request.text(),
			redirect: 'manual',
		});
	};
	const sides: Sides = { origin: ORIGIN, send, tailnet: TAILNET, tailnetSend };
	return {
		...f,
		...served,
		reading,
		authorization,
		send,
		toPublic,
		tailnetSend,
		sides,
	};
}

/** The tools an MCP answer lists, by name. */
async function toolNames(response: Response) {
	const body = (await response.json()) as {
		result: {
			tools: { name: string; annotations?: { readOnlyHint?: boolean } }[];
		};
	};
	return body.result.tools;
}

const bearer = (token: string | undefined) => ({
	authorization: `Bearer ${token}`,
});

test('serve names where connectors reach it and where they are approved; the public address serves no page', async () => {
	const t = await setup();
	expect(t.stderr()).toContain(
		`Serving connectors at ${ORIGIN}/ from ${t.public}: an HTTPS tunnel from that address must forward to this port. They are approved at ${TAILNET}/.allow.`,
	);
	const local = await fetch(mcpRequest(t.local, 'tools/list'));
	expect(local.status).toBe(200);
	expect((await toolNames(local)).length).toBe(10);
	expect((await fetch(`${t.local}/`)).status).toBe(200);
	const open = await t.toPublic(mcpRequest(ORIGIN, 'tools/list'));
	expect(open.status).toBe(401);
	expect(open.headers.get('www-authenticate')).toBe(
		`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`,
	);
	for (const path of ['/', '/reading/', '/.allow', '/.sign-in'])
		expect([
			path,
			(await t.toPublic(new Request(`${ORIGIN}${path}`))).status,
		]).toEqual([path, 404]);
	const metadata = await t.toPublic(
		new Request(`${ORIGIN}/.well-known/oauth-protected-resource`),
	);
	expect(((await metadata.json()) as { resource: string }).resource).toBe(
		`${ORIGIN}/`,
	);
});

test('the approval page on the private listener approves only from its own pages', async () => {
	const t = await setup();
	const { query } = await authorizeQuery(`${ORIGIN}/`, 'read offline_access');
	const allow = await reachAllow(ORIGIN, t.send, TAILNET, query);
	const page = await t.tailnetSend(new Request(allow));
	expect(page.status).toBe(200);
	expect(await page.text()).toContain('Allow claude.ai to use your apps?');
	const foreign = await t.tailnetSend(
		new Request(`${TAILNET}/.allow`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: 'https://evil.example',
			},
			body: JSON.stringify({
				accept: true,
				scope: 'read offline_access',
				oauth_query: allow.search.slice(1),
			}),
		}),
	);
	expect(foreign.status).toBe(403);
	expect(
		JSON.parse((await t.run('access', '--json')).stdout).connectors,
	).toEqual([]);
	const own = await answerAllow(t.tailnetSend, allow, {
		accept: true,
		scope: 'read offline_access',
	});
	expect(own.status).toBe(200);
	expect(((await own.json()) as { url: string }).url).toContain('code=');
});

test('a read token lists only read-only actions and its call to a write action is refused; a write token can call it', async () => {
	const t = await setup();
	const read = await connectClaude(t.sides, 'read offline_access');
	const all = await toolNames(await fetch(mcpRequest(t.local, 'tools/list')));
	const listed = await t.toPublic(
		mcpRequest(ORIGIN, 'tools/list', {}, bearer(read.access_token)),
	);
	expect(listed.status).toBe(200);
	const readOnly = all
		.filter((tool) => tool.annotations?.readOnlyHint === true)
		.map((tool) => tool.name);
	expect(readOnly).toContain('reading_week_show');
	expect(readOnly).not.toContain('reading_log');
	expect((await toolNames(listed)).map((tool) => tool.name)).toEqual(readOnly);
	const shown = await t.toPublic(
		mcpRequest(
			ORIGIN,
			'tools/call',
			{ name: 'reading_week_show', arguments: {} },
			bearer(read.access_token),
		),
	);
	expect(shown.status).toBe(200);
	expect(
		((await shown.json()) as { result: { structuredContent: unknown } }).result
			.structuredContent,
	).toEqual({ returned: 210 });
	const refused = await t.toPublic(
		mcpRequest(
			ORIGIN,
			'tools/call',
			{ name: 'reading_log', arguments: { minutes: 5 } },
			bearer(read.access_token),
		),
	);
	expect(refused.status).toBe(200);
	const { result } = (await refused.json()) as {
		result: { isError?: boolean; content: { text: string }[] };
	};
	expect(result.isError).toBe(true);
	expect(result.content[0]?.text).toContain(
		'reading log changes files, and this call may only read',
	);
	expect(await Bun.file(join(t.reading, 'data/2026.csv')).exists()).toBe(false);
	expect(await gitIn(t.reading, 'rev-list', '--count', 'HEAD')).toBe('1');

	const write = await connectClaude(t.sides, 'read write offline_access');
	const logged = await t.toPublic(
		mcpRequest(
			ORIGIN,
			'tools/call',
			{ name: 'reading_log', arguments: { minutes: 5 } },
			bearer(write.access_token),
		),
	);
	expect(logged.status).toBe(200);
	expect(await readFile(join(t.reading, 'data/2026.csv'), 'utf8')).toBe(
		'minutes,book\n5,\n',
	);
	expect(await gitIn(join(t.reading, 'data'), 'log', '-1', '--format=%s')).toBe(
		'reading: log 5',
	);
});

test('epicenter access lists connectors and revokes one while serve runs', async () => {
	const t = await setup();
	const tokens = await connectClaude(t.sides, 'read write offline_access');
	const listCall = (token: string | undefined) =>
		t.toPublic(mcpRequest(ORIGIN, 'tools/list', {}, bearer(token)));
	const listed = await t.run('access', '--json');
	expect(listed.code).toBe(0);
	expect(JSON.parse(listed.stdout).connectors).toMatchObject([
		{
			clientId: CLAUDE_ID,
			name: 'Claude',
			host: 'claude.ai',
			scope: 'read write offline_access',
			families: 1,
		},
	]);
	const text = await t.run('access');
	expect(text.stdout).toContain(
		`claude.ai  ${CLAUDE_ID}, which calls itself Claude\n  reads and changes, approved `,
	);
	expect(text.stdout).toContain('1 connection');
	expect((await t.run('access', 'invite', 'phone')).code).toBe(2);
	expect((await listCall(tokens.access_token)).status).toBe(200);

	const revoked = await t.run('access', 'revoke', 'claude.ai');
	expect(revoked.code).toBe(0);
	expect(revoked.stdout).toContain('claude.ai can no longer reach your apps');
	expect((await listCall(tokens.access_token)).status).toBe(401);
	const refused = await refresh(ORIGIN, t.send, tokens.refresh_token);
	expect(refused.status).toBe(400);
	expect(refused.body.error).toBe('invalid_grant');
	expect(
		JSON.parse((await t.run('access', '--json')).stdout).connectors,
	).toEqual([]);
	expect((await t.run('access', 'revoke', 'nobody', '--json')).code).toBe(2);
});

test('epicenter access without a connectors block says what to add', async () => {
	const f = await fixture();
	cleanups.push(() => rm(f.root, { recursive: true, force: true }));
	const result = await f.run('access', '--json');
	expect(result.code).toBe(2);
	const { error } = JSON.parse(result.stdout);
	expect(error.message).toContain('has no connectors block');
	expect(error.next).toContain('tailnet');
	expect(await Bun.file(join(f.home, 'access.local.sqlite')).exists()).toBe(
		false,
	);
});

test('a tool name that is an epicenter command runs nothing', async () => {
	const t = await setup();
	for (const name of ['access_revoke', 'sync_reading', 'history_reading']) {
		const response = await fetch(
			`${t.local}/`,
			mcpRequest(t.local, 'tools/call', { name, arguments: {} }),
		);
		const body = (await response.json()) as {
			result: { isError?: boolean; content: { text: string }[] };
		};
		expect(body.result.isError).toBe(true);
		expect(body.result.content[0]?.text).toContain(`Unknown tool ${name}`);
	}
	expect(
		JSON.parse((await t.run('access', '--json')).stdout).connectors,
	).toEqual([]);
});

test('the private listener answers only this computer and the tailnet, never a tunnel', async () => {
	const t = await setup();
	const call = (headers: Record<string, string>) =>
		fetch(mcpRequest(t.local, 'tools/list', {}, headers));
	const refused: Record<string, string>[] = [
		{ host: 'evil.example' },
		{ host: 'rebound.example.com:4747' },
		{ host: 'studio.tailnet.ts.net', 'tailscale-funnel-request': '?1' },
		{ host: 'localhost', 'cf-connecting-ip': '203.0.113.9' },
	];
	for (const headers of refused) {
		const response = await call(headers);
		expect([headers, response.status]).toEqual([headers, 403]);
	}
	for (const host of [
		'localhost',
		'127.0.0.1',
		'[::1]:4747',
		'studio.tailnet.ts.net',
	]) {
		const response = await call({ host });
		expect([host, response.status]).toEqual([host, 200]);
	}
});

test('serve with connectors refuses a --host that is not loopback', async () => {
	const f = await fixture();
	cleanups.push(() => rm(f.root, { recursive: true, force: true }));
	await writeFile(join(f.home, 'EPICENTER.md'), MARKER);
	for (const host of ['0.0.0.0', '100.101.102.103']) {
		const refused = await f.run('serve', '--host', host, '--port', '0');
		expect(refused.code).toBe(2);
		expect(refused.stderr).toContain(
			`With connectors, serve listens only on a loopback address, not ${host}`,
		);
	}
});

test('serve refuses a --port that is also connectors.port', async () => {
	const f = await fixture();
	cleanups.push(() => rm(f.root, { recursive: true, force: true }));
	await writeFile(
		join(f.home, 'EPICENTER.md'),
		MARKER.replace('  port: 0', '  port: 4757'),
	);
	const refused = await f.run('serve', '--port', '4757');
	expect(refused.code).toBe(2);
	expect(refused.stderr).toContain(
		'--port 4757 is also connectors.port; the public listener needs a port of its own',
	);
});
