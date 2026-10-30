import { join } from 'node:path';

const directory = join(import.meta.dir, '.tmp');
const html =
	'<!doctype html><html><body><p id="status">WAITING</p><script>window.__inline=1</script><script type="module" src="/app.js"></script></body></html>';
const script =
	"window.__ran=1; const worker=new Worker('/worker.js',{type:'module'}); worker.onmessage=e=>{document.querySelector('#status').textContent=e.data;window.__ready=true};worker.onerror=e=>{document.querySelector('#status').textContent='WORKER FAILED'}";
const worker = "postMessage('WORKER READY')";
const responses = new Map([
	['/', ['text/html', html]],
	['/app.js', ['text/javascript', script]],
	['/worker.js', ['text/javascript', worker]],
]);

Bun.serve({
	hostname: '127.0.0.1',
	port: 38475,
	tls: {
		cert: Bun.file(join(directory, 'upstream-cert.pem')),
		key: Bun.file(join(directory, 'upstream-key.pem')),
	},
	fetch(request) {
		const path = new URL(request.url).pathname;
		const entry = responses.get(path);
		console.log('UPSTREAM', path, entry ? 200 : 404);
		return new Response(entry?.[1] ?? 'Not found', {
			status: entry ? 200 : 404,
			headers: {
				'content-type': entry?.[0] ?? 'text/plain',
				'content-security-policy': "script-src 'self'; worker-src 'self'",
				'cache-control': 'no-store',
			},
		});
	},
});
