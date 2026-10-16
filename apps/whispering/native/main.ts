#!/usr/bin/env bun
/**
 * Entry point of the Whispering host.
 *
 * The desktop shell starts this process, reads one JSON line from its standard
 * output to learn the port, and loads the page from it. The host stops when
 * the shell closes its standard input, so it never outlives the window.
 *
 * The shell decides where the data folder is and who may reach it. It passes
 * the directory it resolved and the per-launch credential, and this process
 * runs only with both: it has no default folder and no way to be the page's
 * folder on its own.
 *
 * Configuration is the environment:
 *
 * - `WHISPERING_DATA_ROOT`: the data folder, as the shell resolved it.
 * - `WHISPERING_HOST_TOKEN`: the per-launch credential, from the shell.
 * - `WHISPERING_UI_DIST`: the built page. Defaults to this app's `build/`.
 * - `WHISPERING_HOST_PORT`: a fixed port. Defaults to any free port.
 * - `WHISPERING_DEBUG=1`: set by a debug shell; allows fixture audio and
 *   failure injection.
 * - `WHISPERING_AUDIO_FIXTURE`: a file whose bytes answer every recording, in
 *   a debug shell only.
 */
import { join } from 'node:path';
import { createHost } from './host.js';

const env = process.env;
const log = (message: string) => console.error(`[whispering-host] ${message}`);

const root = env.WHISPERING_DATA_ROOT;
const token = env.WHISPERING_HOST_TOKEN;
if (!root || !token)
	throw new Error(
		'The Whispering host is started by the desktop shell, which passes the data folder and the launch credential. Run `bun dev:whispering`.',
	);

const host = await createHost({
	root,
	token,
	uiDist: env.WHISPERING_UI_DIST || join(import.meta.dir, '..', 'build'),
	debug: env.WHISPERING_DEBUG === '1',
	fixturePath: env.WHISPERING_AUDIO_FIXTURE?.trim() || undefined,
	env,
	log,
});

const server = Bun.serve({
	hostname: '127.0.0.1',
	port: Number(env.WHISPERING_HOST_PORT ?? 0),
	// A transcription or transformation can take longer than the default ten
	// seconds to answer.
	idleTimeout: 255,
	fetch: (request) => host.handle(request),
});
const port = server.port ?? 0;
host.listening(port);

let stopping = false;
async function stop(reason: string) {
	if (stopping) return;
	stopping = true;
	log(`Stopping: ${reason}`);
	await server.stop(true);
	await host.close().catch((cause) => log(`Close failed: ${String(cause)}`));
	process.exit(0);
}

process.on('SIGINT', () => void stop('interrupted'));
process.on('SIGTERM', () => void stop('terminated'));

// The shell sends nothing on standard input; it closes it when it exits.
process.stdin.on('data', () => {});
process.stdin.on('end', () => void stop('the shell closed'));
process.stdin.on('close', () => void stop('the shell closed'));
process.stdin.resume();

// The one line the shell waits for. Everything else goes to standard error.
// It carries no folder path: the shell already knows the one it chose.
console.log(JSON.stringify({ ready: true, port }));
