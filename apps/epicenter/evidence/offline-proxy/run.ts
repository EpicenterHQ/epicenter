import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

const directory = import.meta.dir;
const scratch = join(directory, '.tmp');
const bun = process.execPath;
mkdirSync(scratch, { recursive: true });
rmSync(join(scratch, 'recorded.json'), { force: true });
rmSync(join(scratch, 'upstream-rejection.txt'), { force: true });

function command(argv: string[], env: Record<string, string> = {}) {
	return Bun.spawnSync(argv, {
		cwd: directory,
		env: { ...process.env, ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	});
}

function certificate(name: string) {
	const result = command([
		'openssl',
		'req',
		'-x509',
		'-newkey',
		'rsa:2048',
		'-nodes',
		'-keyout',
		join(scratch, `${name}key.pem`),
		'-out',
		join(scratch, `${name}cert.pem`),
		'-days',
		'1',
		'-subj',
		'/CN=probe.epicenter.test',
		'-addext',
		'subjectAltName=DNS:probe.epicenter.test',
	]);
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

certificate('');
certificate('upstream-');

function start(file: string, env: Record<string, string> = {}) {
	return Bun.spawn([bun, join(directory, file)], {
		cwd: directory,
		env: { ...process.env, ...env },
		stdout: 'inherit',
		stderr: 'inherit',
	});
}

async function stop(process: Bun.Subprocess) {
	process.kill();
	await process.exited;
}

async function waitForPort(port: number, process: Bun.Subprocess) {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (process.exitCode !== null)
			throw new Error(`Server on ${port} exited before listening`);
		const listening = await new Promise<boolean>((resolve) => {
			const socket = createConnection(port, '127.0.0.1');
			socket.once('connect', () => {
				socket.destroy();
				resolve(true);
			});
			socket.once('error', () => resolve(false));
		});
		if (listening) return;
		await Bun.sleep(100);
	}
	throw new Error(`Server on ${port} did not start`);
}

async function foreignConnect() {
	return new Promise<string>((resolve, reject) => {
		const socket = createConnection(38474, '127.0.0.1');
		let response = '';
		socket.once('connect', () =>
			socket.write(
				'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n',
			),
		);
		socket.on('data', (data) => {
			response += data.toString();
			socket.destroy();
			resolve(response);
		});
		socket.once('error', reject);
	});
}

function probe(
	label: string,
	expectedSuccess: boolean,
	env: Record<string, string> = {},
	expectedText?: string,
) {
	const result = command(
		['swift', join(directory, 'probe.swift'), scratch],
		env,
	);
	const output = result.stdout.toString() + result.stderr.toString();
	console.log(`\n${label}\n${output.trim()}`);
	if ((result.exitCode === 0) !== expectedSuccess)
		throw new Error(`${label}: unexpected exit ${result.exitCode}`);
	if (expectedText && !output.includes(expectedText))
		throw new Error(`${label}: missing ${expectedText}`);
}

let upstream: Bun.Subprocess | undefined;
let proxy: Bun.Subprocess | undefined;
try {
	upstream = start('upstream.ts');
	proxy = start('proxy.ts');
	await waitForPort(38475, upstream);
	await waitForPort(38474, proxy);
	probe('ONLINE', true, {}, 'WORKER READY');
	await stop(proxy);
	proxy = undefined;
	await stop(upstream);
	upstream = undefined;

	if (!existsSync(join(scratch, 'recorded.json')))
		throw new Error('Missing recorded responses');
	proxy = start('proxy.ts', { PROBE_OFFLINE: '1' });
	await waitForPort(38474, proxy);
	probe('COLD OFFLINE REPLAY', true, {}, 'WORKER READY');
	if (!(await foreignConnect()).includes('503 Service Unavailable'))
		throw new Error('Offline proxy allowed a foreign CONNECT');
	console.log('OFFLINE FOREIGN CONNECT: 503 Service Unavailable');
	probe('WRONG PROXY PIN', false, { PROBE_BAD_PIN: '1' }, 'TRUST REJECTED');
	await stop(proxy);
	proxy = undefined;

	upstream = start('upstream.ts');
	proxy = start('proxy.ts', { PROBE_BAD_UPSTREAM_CA: '1' });
	await waitForPort(38475, upstream);
	await waitForPort(38474, proxy);
	probe('WRONG UPSTREAM CERTIFICATE', false);
	const rejected = join(scratch, 'upstream-rejection.txt');
	if (
		!existsSync(rejected) ||
		!readFileSync(rejected, 'utf8').includes('DEPTH_ZERO_SELF_SIGNED_CERT')
	) {
		throw new Error('Upstream TLS rejection was not observed');
	}
	console.log('UPSTREAM TLS REJECTION:', readFileSync(rejected, 'utf8'));
	console.log('\nAll expected success and failure cases passed.');
} finally {
	if (proxy) await stop(proxy);
	if (upstream) await stop(upstream);
}
