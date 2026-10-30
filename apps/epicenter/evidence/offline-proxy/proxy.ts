import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { createSecureContext, TLSSocket } from 'node:tls';

const host = 'probe.epicenter.test';
const port = 38474;
const directory = join(import.meta.dir, '.tmp');
const cert = readFileSync(join(directory, 'cert.pem'));
const key = readFileSync(join(directory, 'key.pem'));
const context = createSecureContext({ cert, key });
const cachePath = join(directory, 'recorded.json');
const offline = process.env.PROBE_OFFLINE === '1';
const recorded: Record<
	string,
	{ status: number; headers: Record<string, string>; body: string }
> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};

function respond(
	secure: TLSSocket,
	path: string,
	entry: { status: number; headers: Record<string, string>; body: string },
) {
	const body = Buffer.from(entry.body, 'base64');
	const headers = [
		`HTTP/1.1 ${entry.status} ${entry.status === 200 ? 'OK' : 'Not Found'}`,
		...Object.entries(entry.headers)
			.filter(
				([name]) =>
					!['content-length', 'connection', 'transfer-encoding'].includes(name),
			)
			.map(([name, value]) => `${name}: ${value}`),
		`Content-Length: ${body.length}`,
		'Connection: close',
		'',
		'',
	].join('\r\n');
	secure.end(Buffer.concat([Buffer.from(headers), body]));
}

function fetchUpstream(
	path: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
	return new Promise((resolve, reject) => {
		const req = httpsRequest(
			{
				hostname: '127.0.0.1',
				port: 38475,
				path,
				method: 'GET',
				servername: host,
				ca: readFileSync(
					join(
						directory,
						process.env.PROBE_BAD_UPSTREAM_CA === '1'
							? 'cert.pem'
							: 'upstream-cert.pem',
					),
				),
				rejectUnauthorized: true,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (chunk) => chunks.push(chunk));
				res.on('end', () =>
					resolve({
						status: res.statusCode ?? 502,
						headers: Object.fromEntries(
							Object.entries(res.headers).filter(
								([, value]) => typeof value === 'string',
							),
						) as Record<string, string>,
						body: Buffer.concat(chunks).toString('base64'),
					}),
				);
			},
		);
		req.on('error', reject);
		req.end();
	});
}

createServer((socket) => {
	let pending = Buffer.alloc(0);
	socket.once('data', (chunk) => {
		pending = Buffer.concat([pending, chunk]);
		const request = pending.toString('utf8');
		const line = request.split('\r\n', 1)[0];
		const match = /^CONNECT ([a-z0-9.-]+):443 HTTP\/1\.1$/.exec(line);
		if (!match) {
			// The Tauri gate asserts that no refused tunnel was attempted.
			console.log('REFUSED', line);
			socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
			return;
		}
		if (match[1] !== host) {
			if (offline) {
				socket.end(
					'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n',
				);
				return;
			}
			const upstream = createConnection({ host: match[1], port: 443 }, () => {
				socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
				socket.pipe(upstream);
				upstream.pipe(socket);
				console.log('TUNNEL', match[1]);
			});
			upstream.on('error', () => socket.destroy());
			return;
		}
		socket.write('HTTP/1.1 200 Connection Established\r\n\r\n', () => {
			const secure = new TLSSocket(socket, {
				isServer: true,
				secureContext: context,
			});
			let raw = '';
			secure.on('data', async (bytes) => {
				raw += bytes.toString('utf8');
				if (!raw.includes('\r\n\r\n')) return;
				const [method, path] = raw.split(' ', 3);
				if (method !== 'GET') {
					secure.end(
						'HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n',
					);
					return;
				}
				try {
					const entry = offline ? recorded[path] : await fetchUpstream(path);
					if (!entry) {
						secure.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
						return;
					}
					if (!offline) {
						recorded[path] = entry;
						writeFileSync(cachePath, JSON.stringify(recorded));
					}
					respond(secure, path, entry);
					console.log(offline ? 'REPLAY' : 'RECORD', path, entry.status);
				} catch (error) {
					if (process.env.PROBE_BAD_UPSTREAM_CA === '1') {
						writeFileSync(
							join(directory, 'upstream-rejection.txt'),
							String((error as { code?: string }).code),
						);
					}
					console.error('UPSTREAM FAILED', path, error);
					secure.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
				}
			});
			secure.on('error', (error) => console.error('TLS', error.message));
		});
	});
	socket.on('error', (error) => console.error('SOCKET', error.message));
}).listen(port, '127.0.0.1', () => console.log(`proxy on ${port}`));
