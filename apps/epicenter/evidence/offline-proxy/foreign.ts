import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

// A foreign origin for the Tauri gate: one plain HTTP page on loopback. It is
// raw TCP so the log records every connection, including one that never
// sends an HTTP request line (a TLS attempt, for example).
const log = join(import.meta.dir, '.tmp', 'foreign-requests.log');
const page =
	'<!doctype html><html><body><p id="foreign">FOREIGN PAGE</p></body></html>';
const received = new WeakMap<object, string>();

function record(line: string) {
	appendFileSync(log, `${line}\n`);
	console.log('FOREIGN', line);
}

Bun.listen({
	hostname: '127.0.0.1',
	port: 38476,
	socket: {
		open(socket) {
			record('CONNECTION');
			received.set(socket, '');
		},
		data(socket, data) {
			const request = (received.get(socket) ?? '') + data.toString('latin1');
			received.set(socket, request);
			if (!request.includes('\r\n\r\n')) return;
			record(`REQUEST ${request.split('\r\n', 1)[0]}`);
			const body = Buffer.from(page);
			socket.end(
				Buffer.concat([
					Buffer.from(
						`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nCache-Control: no-store\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
					),
					body,
				]),
			);
		},
		error(_socket, error) {
			console.error('FOREIGN SOCKET', error.message);
		},
	},
});
console.log('foreign on 38476');
