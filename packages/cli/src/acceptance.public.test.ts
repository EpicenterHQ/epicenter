/**
 * The public listener as `serve` runs it, with real apps, and `epicenter
 * access` beside it. Runs the real CLI against a temporary HOME whose
 * `EPICENTER.md` has a public address.
 *
 * The OAuth browser leg runs in this test process, on the same
 * `access.local.sqlite` that `serve` holds open, through the public handler
 * with a stubbed CIMD fetch: serve's own fetch would go to claude.ai. The
 * tokens and cookies it produces are then used against serve's public port,
 * which checks them against the shared keys and sessions, as a second process
 * such as `epicenter access` does.
 *
 * The public address is `https://localhost:9/`, where nothing listens, so
 * serve's check of its own public address finds nothing without leaving this
 * computer. The test of a tunnel aimed at the private port runs its own
 * HTTPS forwarder there instead.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAuthorizationServer } from './authorization-server.ts';
import type { Site } from './http.ts';
import { publicHandler } from './public.ts';
import { fixture, gitIn, readingApp } from './runner.test-support.ts';
import {
	browser,
	CLAUDE_ID,
	claudeOnly,
	connectClaude,
	mcpRequest,
	refresh,
	type Send,
	softwarePasskey,
} from './sign-in.test-support.ts';

setDefaultTimeout(60_000);

const PUBLIC_URL = 'https://localhost:9/';
const ORIGIN = 'https://localhost:9';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Start `serve` and wait for both of its listeners. */
async function serve(
	f: Awaited<ReturnType<typeof fixture>>,
	{ port = 0, env = {} }: { port?: number; env?: Record<string, string> } = {},
) {
	const child = Bun.spawn(
		[process.execPath, f.bin, 'serve', '--port', String(port)],
		{
			cwd: f.root,
			env: { ...f.env, ...env },
			stdout: 'ignore',
			stderr: 'pipe',
		},
	);
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
			const open = / at (http:\/\/127\.0\.0\.1:\d+): an HTTPS tunnel/.exec(
				output,
			)?.[1];
			if (local && open) ready.resolve({ local, public: open });
		}
		ready.reject(new Error(output || 'serve exited before listening'));
	})();
	/** Wait until serve has written `text`. */
	const said = async (text: string) => {
		for (let waited = 0; !output.includes(text); waited += 50) {
			if (waited > 15_000)
				throw new Error(`serve never said ${text}: ${output}`);
			await Bun.sleep(50);
		}
	};
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
	return { ...bases, stderr: () => output, said };
}

/** A fixture whose Epicenter has a public address, `reading` in it, and serve running. */
async function setup() {
	const f = await fixture();
	await writeFile(
		join(f.home, 'EPICENTER.md'),
		`---\nport: 4747\npublic: ${PUBLIC_URL}\npublicPort: 0\n---\n`,
	);
	const reading = await f.folder(join(f.home, 'reading'), readingApp);
	const served = await serve(f);
	cleanups.push(() => rm(f.root, { recursive: true, force: true }));
	// This process's own view of the same sign-in, for the browser leg.
	const authorization = await openAuthorizationServer(
		f.home,
		PUBLIC_URL,
		claudeOnly(),
	);
	cleanups.unshift(async () => authorization.close());
	const unreachable = async () => {
		throw new Error('the browser leg never reaches the site');
	};
	const site: Site = {
		mcp: unreachable,
		launcher: unreachable,
		view: unreachable,
	};
	const inProcess = publicHandler(authorization, site);
	/** The browser leg, in this process. */
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
	/** A device that registers a passkey from `token`, signing it in. */
	const device = async (token: string) => {
		const made = {
			browser: browser(ORIGIN, send),
			passkey: await softwarePasskey(ORIGIN),
		};
		expect((await made.browser.register(made.passkey, token)).status).toBe(200);
		return made;
	};
	/** An invite made by `epicenter access invite`, as its token. */
	const invite = async (name: string) => {
		const made = await f.run('access', 'invite', name, '--json');
		expect(made.code).toBe(0);
		const { url } = JSON.parse(made.stdout) as { url: string };
		expect(url.startsWith(`${ORIGIN}/.sign-in?invite=`)).toBe(true);
		return new URL(url).searchParams.get('invite') as string;
	};
	return {
		...f,
		...served,
		reading,
		authorization,
		send,
		toPublic,
		device,
		invite,
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

test('serve names the public address and its port, says the address does not answer, and the private listener still needs nothing', async () => {
	const t = await setup();
	expect(t.stderr()).toContain(`Serving ${PUBLIC_URL} at ${t.public}`);
	await t.said(`${PUBLIC_URL} does not answer`);
	const local = await fetch(mcpRequest(t.local, 'tools/list'));
	expect(local.status).toBe(200);
	expect((await toolNames(local)).length).toBe(10);
	expect((await fetch(`${t.local}/`)).status).toBe(200);
	const open = await t.toPublic(mcpRequest(ORIGIN, 'tools/list'));
	expect(open.status).toBe(401);
	expect(open.headers.get('www-authenticate')).toBe(
		`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`,
	);
	const page = await t.toPublic(new Request(`${ORIGIN}/reading/`));
	expect(page.status).toBe(302);
	expect(page.headers.get('location')).toBe(
		`/.sign-in?next=${encodeURIComponent('/reading/')}`,
	);
	const metadata = await t.toPublic(
		new Request(`${ORIGIN}/.well-known/oauth-protected-resource`),
	);
	expect(((await metadata.json()) as { resource: string }).resource).toBe(
		PUBLIC_URL,
	);
});

test('a read token lists only read-only actions and cannot call a write action; a write token can', async () => {
	const t = await setup();
	const person = await t.device(await t.invite('phone'));
	const read = await connectClaude(
		ORIGIN,
		t.send,
		person,
		'read offline_access',
	);
	const bearer = (token: string | undefined) => ({
		authorization: `Bearer ${token}`,
	});
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
	expect(refused.status).toBe(403);
	expect(refused.headers.get('www-authenticate')).toContain(
		'error="insufficient_scope", scope="write"',
	);
	expect(await Bun.file(join(t.reading, '2026.csv')).exists()).toBe(false);
	expect(await gitIn(t.reading, 'rev-list', '--count', 'HEAD')).toBe('1');

	const write = await connectClaude(
		ORIGIN,
		t.send,
		person,
		'read write offline_access',
	);
	const logged = await t.toPublic(
		mcpRequest(
			ORIGIN,
			'tools/call',
			{ name: 'reading_log', arguments: { minutes: 5 } },
			bearer(write.access_token),
		),
	);
	expect(logged.status).toBe(200);
	expect(await readFile(join(t.reading, '2026.csv'), 'utf8')).toBe(
		'minutes,book\n5,\n',
	);
	expect(await gitIn(t.reading, 'log', '-1', '--format=%s')).toBe(
		'reading: log 5',
	);
});

test('a child limited to reading refuses a write action and a command', async () => {
	const t = await setup();
	const report = join(tmpdir(), `epicenter-report-${crypto.randomUUID()}.json`);
	cleanups.push(() => rm(report, { force: true }));
	for (const words of [
		['reading', 'log', '5'],
		['access', 'invite'],
	]) {
		await t.run(`--report=${report}`, '--read-only-call', ...words);
		const { answer } = JSON.parse(await readFile(report, 'utf8')) as {
			answer: { error?: { name: string } };
		};
		expect(answer.error?.name).toBe('Refused');
	}
	expect(await Bun.file(join(t.reading, '2026.csv')).exists()).toBe(false);
	await t.run(
		`--report=${report}`,
		'--read-only-call',
		'reading',
		'week',
		'show',
	);
	expect(JSON.parse(await readFile(report, 'utf8')).answer).toEqual({
		returned: 210,
	});
});

test("a person's session reaches the site from the public origin's own pages only", async () => {
	const t = await setup();
	const person = await t.device(await t.invite('phone'));
	const cookie = person.browser.cookie();
	const call = (origin: string) =>
		t.toPublic(
			mcpRequest(
				ORIGIN,
				'tools/call',
				{ name: 'reading_log', arguments: { minutes: 7 } },
				{ cookie, origin },
			),
		);
	expect((await call('https://evil.example')).status).toBe(401);
	expect(await Bun.file(join(t.reading, '2026.csv')).exists()).toBe(false);
	expect((await call(ORIGIN)).status).toBe(200);
	expect(await readFile(join(t.reading, '2026.csv'), 'utf8')).toBe(
		'minutes,book\n7,\n',
	);
	const launcher = await t.toPublic(
		new Request(`${ORIGIN}/`, { headers: { cookie } }),
	);
	expect(launcher.status).toBe(200);
	expect(await launcher.text()).toContain('<title>Epicenter</title>');
});

test('epicenter access lists grants, invites, and revokes a grant, a connector, and a person while serve runs', async () => {
	const t = await setup();
	const phone = await t.device(await t.invite('phone'));
	const laptop = await t.device(await t.invite('laptop'));
	const fromPhone = await connectClaude(
		ORIGIN,
		t.send,
		phone,
		'read write offline_access',
	);
	const fromLaptop = await connectClaude(
		ORIGIN,
		t.send,
		laptop,
		'read offline_access',
	);
	const bearer = (token: string | undefined) => ({
		authorization: `Bearer ${token}`,
	});
	const listCall = (token: string | undefined) =>
		t.toPublic(mcpRequest(ORIGIN, 'tools/list', {}, bearer(token)));
	const listed = await t.run('access', '--json');
	expect(listed.code).toBe(0);
	expect(JSON.parse(listed.stdout).access).toMatchObject([
		{ kind: 'person', name: 'phone' },
		{ kind: 'person', name: 'laptop' },
		{
			kind: 'grant',
			clientId: CLAUDE_ID,
			name: 'Claude',
			host: 'claude.ai',
			person: 'phone',
			scope: 'read write offline_access',
			families: 1,
		},
		{ kind: 'grant', clientId: CLAUDE_ID, person: 'laptop', families: 1 },
	]);
	const text = await t.run('access');
	expect(text.stdout).toContain('People\n  phone  approved ');
	expect(text.stdout).toContain(
		`  claude.ai  ${CLAUDE_ID}, which calls itself Claude\n    approved by phone: reads and changes, approved `,
	);
	expect(text.stdout).toContain('    approved by laptop: reads, approved ');
	expect(text.stdout).toContain('1 connection');
	expect((await t.run('access', 'invite', 'phone')).code).toBe(2);

	// One grant: the phone's approval of Claude.
	const grant = await t.run('access', 'revoke', 'claude.ai', 'phone');
	expect(grant.code).toBe(0);
	expect(grant.stdout).toContain('1 grant of claude.ai ended');
	expect((await listCall(fromPhone.access_token)).status).toBe(401);
	expect((await listCall(fromLaptop.access_token)).status).toBe(200);
	const refused = await refresh(ORIGIN, t.send, fromPhone.refresh_token);
	expect(refused.status).toBe(400);
	expect(refused.body.error).toBe('invalid_grant');

	// The connector: every grant left.
	expect((await t.run('access', 'revoke', 'Claude')).code).toBe(0);
	expect((await listCall(fromLaptop.access_token)).status).toBe(401);
	expect((await refresh(ORIGIN, t.send, fromLaptop.refresh_token)).status).toBe(
		400,
	);

	// A person: signed out everywhere.
	const cookie = phone.browser.cookie();
	expect(
		(await t.toPublic(new Request(`${ORIGIN}/`, { headers: { cookie } })))
			.status,
	).toBe(200);
	const person = await t.run('access', 'revoke', 'phone');
	expect(person.code).toBe(0);
	expect(person.stdout).toContain('phone is signed out');
	expect(
		(await t.toPublic(new Request(`${ORIGIN}/`, { headers: { cookie } })))
			.status,
	).toBe(302);
	expect(
		JSON.parse((await t.run('access', '--json')).stdout).access,
	).toMatchObject([{ kind: 'person', name: 'laptop' }]);
	const missing = await t.run('access', 'revoke', 'nobody', '--json');
	expect(missing.code).toBe(2);
});

test('epicenter access without a public address says what to add', async () => {
	const f = await fixture();
	cleanups.push(() => rm(f.root, { recursive: true, force: true }));
	const result = await f.run('access', '--json');
	expect(result.code).toBe(2);
	const { error } = JSON.parse(result.stdout);
	expect(error.message).toContain('has no public address');
	expect(error.next).toContain('publicPort');
	expect(await Bun.file(join(f.home, 'access.local.sqlite')).exists()).toBe(
		false,
	);
});

test('a tool name that is an epicenter command runs nothing', async () => {
	const t = await setup();
	for (const name of ['access_invite', 'sync_reading', 'history_reading']) {
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
	expect(JSON.parse((await t.run('access', '--json')).stdout).access).toEqual(
		[],
	);
});

test('the private listener answers only this computer and the tailnet, never a tunnel, and names itself', async () => {
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
		expect(response.headers.get('epicenter-listener')).toBe('private');
	}
	for (const host of [
		'localhost',
		'127.0.0.1',
		'[::1]:4747',
		'studio.tailnet.ts.net',
	]) {
		const response = await call({ host });
		expect([host, response.status]).toEqual([host, 200]);
		expect(response.headers.get('epicenter-listener')).toBe('private');
	}
	// The public listener does not carry it.
	const open = await t.toPublic(
		new Request(`${ORIGIN}/.well-known/oauth-protected-resource`),
	);
	expect(open.headers.get('epicenter-listener')).toBeNull();
});

test('serve with a public address refuses a --host that is not loopback', async () => {
	const f = await fixture();
	cleanups.push(() => rm(f.root, { recursive: true, force: true }));
	await writeFile(
		join(f.home, 'EPICENTER.md'),
		`---\nport: 4747\npublic: ${PUBLIC_URL}\npublicPort: 0\n---\n`,
	);
	for (const host of ['0.0.0.0', '100.101.102.103']) {
		const refused = await f.run('serve', '--host', host, '--port', '0');
		expect(refused.code).toBe(2);
		expect(refused.stderr).toContain(
			`With a public address, serve listens only on a loopback address, not ${host}`,
		);
	}
});

test('when the public address reaches the private listener, serve stops it and says why', async () => {
	const f = await fixture();
	cleanups.push(() => rm(f.root, { recursive: true, force: true }));
	await f.folder(join(f.home, 'reading'), readingApp);
	// A self-signed certificate for localhost, so this test's forwarder can
	// stand at an https public address.
	const certs = await mkdtemp(join(tmpdir(), 'epicenter-tls-'));
	cleanups.push(() => rm(certs, { recursive: true, force: true }));
	const made = Bun.spawnSync(
		[
			'openssl',
			'req',
			'-x509',
			'-newkey',
			'rsa:2048',
			'-nodes',
			'-subj',
			'/CN=localhost',
			'-days',
			'1',
			'-keyout',
			join(certs, 'key.pem'),
			'-out',
			join(certs, 'cert.pem'),
		],
		{ stdout: 'ignore', stderr: 'ignore' },
	);
	expect(made.exitCode).toBe(0);
	const free = Bun.serve({ port: 0, fetch: () => new Response() });
	const privatePort = free.port ?? 0;
	free.stop(true);
	// A tunnel aimed at the wrong port: it rewrites Host to a loopback name
	// and adds no header of its own, which only the self-check can catch.
	const tunnel = Bun.serve({
		port: 0,
		tls: {
			cert: Bun.file(join(certs, 'cert.pem')),
			key: Bun.file(join(certs, 'key.pem')),
		},
		async fetch(request) {
			const { pathname, search } = new URL(request.url);
			const headers = new Headers(request.headers);
			headers.set('host', `localhost:${privatePort}`);
			return fetch(`http://127.0.0.1:${privatePort}${pathname}${search}`, {
				method: request.method,
				headers,
				body: request.method === 'GET' ? undefined : await request.text(),
				redirect: 'manual',
			});
		},
	});
	cleanups.push(async () => {
		tunnel.stop(true);
	});
	const publicUrl = `https://localhost:${tunnel.port}/`;
	await writeFile(
		join(f.home, 'EPICENTER.md'),
		`---\nport: 4747\npublic: ${publicUrl}\npublicPort: 0\n---\n`,
	);
	const served = await serve(f, {
		port: privatePort,
		// Trust the forwarder's certificate for serve's own check.
		env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
	});
	await served.said(
		`${publicUrl} reaches this computer's private listener, which asks no one to sign in, so it now refuses every request.`,
	);
	const local = await fetch(mcpRequest(served.local, 'tools/list'));
	expect(local.status).toBe(503);
	expect((await fetch(`${served.local}/reading/`)).status).toBe(503);
	const throughTunnel = await fetch(`${publicUrl}reading/`, {
		tls: { rejectUnauthorized: false },
	});
	expect(throughTunnel.status).toBe(503);
});
