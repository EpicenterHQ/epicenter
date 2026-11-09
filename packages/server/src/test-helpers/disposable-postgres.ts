import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from 'pg';

const execute = promisify(execFile);

/** A private loopback cluster with two connections, and how to tear it down. */
export type DisposablePostgres = {
	clients: readonly [Client, Client];
	port: number;
	/** Close both connections, stop the cluster, and remove its directory. */
	stop: () => Promise<void>;
};

/**
 * Start a private loopback cluster under the OS temp directory (`TMPDIR`).
 * On a startup failure it cleans up before rethrowing.
 */
export async function startDisposablePostgres(): Promise<DisposablePostgres> {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-postgres-'));
	const data = join(directory, 'data');
	const clients: Client[] = [];
	// Do not inherit PG* connection settings or deployment secrets into utilities.
	const options = { env: { PATH: process.env.PATH, LC_ALL: 'C', TZ: 'UTC' } };
	const stop = async () => {
		try {
			await Promise.all(clients.map((client) => client.end()));
		} finally {
			// Also catches a server that started before pg_ctl reported a startup failure.
			if (await Bun.file(join(data, 'postmaster.pid')).exists()) {
				await execute(
					'pg_ctl',
					['-D', data, '-m', 'immediate', '-w', '-t', '15', 'stop'],
					options,
				);
			}
			// Retain the directory if stopping failed; never remove a running cluster.
			await rm(directory, { recursive: true, force: true });
		}
	};
	try {
		await execute(
			'initdb',
			[
				'-D',
				data,
				'-U',
				'postgres',
				'-A',
				'trust',
				'--no-locale',
				'--encoding=UTF8',
			],
			options,
		);
		const listener = createServer();
		await new Promise<void>((resolve, reject) => {
			listener.once('error', reject);
			listener.listen(0, '127.0.0.1', resolve);
		});
		const address = listener.address();
		await new Promise<void>((resolve, reject) =>
			listener.close((error) => (error ? reject(error) : resolve())),
		);
		if (!address || typeof address === 'string')
			throw new Error('No loopback port allocated');
		// Disable Unix sockets: the cluster is reachable only on its loopback port.
		await execute(
			'pg_ctl',
			[
				'-D',
				data,
				'-l',
				join(directory, 'postgres.log'),
				'-o',
				`-h 127.0.0.1 -p ${address.port} -k ''`,
				'-w',
				'-t',
				'15',
				'start',
			],
			options,
		);
		const connection = {
			host: '127.0.0.1',
			port: address.port,
			user: 'postgres',
			password: 'disposable-test-only',
			database: 'postgres',
			ssl: false,
			connectionTimeoutMillis: 5_000,
			query_timeout: 10_000,
		};
		const first = new Client(connection);
		const second = new Client(connection);
		clients.push(first, second);
		await first.connect();
		await second.connect();
		return { clients: [first, second], port: address.port, stop };
	} catch (cause) {
		await stop();
		throw cause;
	}
}

/** Own a private loopback cluster and two connections for one test, including failure cleanup. */
export async function withDisposablePostgres(
	run: (clients: readonly [Client, Client], port: number) => Promise<void>,
) {
	const cluster = await startDisposablePostgres();
	try {
		await run(cluster.clients, cluster.port);
	} finally {
		await cluster.stop();
	}
}
