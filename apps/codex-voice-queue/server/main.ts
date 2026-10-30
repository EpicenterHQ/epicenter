import { createAppServerClient, spawnAppServer } from './app-server-client.js';
import { createCodexService } from './codex-service.js';
import { loadConfig } from './config.js';
import { createHandler } from './http.js';
import { createTranscriber } from './transcribe.js';

const config = loadConfig();
const client = createAppServerClient({
	spawnProcess: () => spawnAppServer(config.codexBin),
});
const service = createCodexService({
	client,
	sandbox: config.sandbox,
	approval: config.approval,
});
const transcriber = createTranscriber({ config });
const handler = createHandler({ config, client, service, transcriber });
const server = Bun.serve({
	hostname: '127.0.0.1',
	port: config.port,
	idleTimeout: 255,
	fetch: handler,
});
console.log(`Listening: http://127.0.0.1:${config.port}`);
// A supplied token is long-lived and may land in service logs, so only a
// per-process random token is printed.
if (process.env.CODEX_VOICE_QUEUE_TOKEN === undefined)
	console.log(`Open: http://127.0.0.1:${config.port}/#token=${config.token}`);
else
	console.log(
		`Open: http://127.0.0.1:${config.port}/#token=<CODEX_VOICE_QUEUE_TOKEN> (token not printed)`,
	);
console.log(`Model: ${config.model ?? '(unavailable)'}`);
console.log(`Policy: sandbox=${config.sandbox}, approval=${config.approval}`);
void client
	.ensureReady()
	.catch((error) =>
		console.error('[gateway] App-server unavailable:', error.message),
	);
async function stop() {
	client.stop();
	await server.stop(true);
	process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
