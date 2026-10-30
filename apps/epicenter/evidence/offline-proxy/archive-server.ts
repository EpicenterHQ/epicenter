const port = 38473;
Bun.serve({
	hostname: '127.0.0.1',
	port,
	fetch(request) {
		const path = new URL(request.url).pathname;
		if (path === '/worker.js') {
			return new Response("postMessage('WORKER READY')", {
				headers: {
					'content-type': 'text/javascript',
					'cache-control': 'no-store',
				},
			});
		}
		if (path === '/app.js') {
			return new Response(
				"window.__ran = (window.__ran || 0) + 1; const root = document.querySelector('#status'); if (root.textContent !== 'WAITING') throw new Error('DOM was already initialized'); const worker = new Worker('/worker.js', {type:'module'}); worker.onmessage = e => { root.textContent = e.data; window.__ready = true }; worker.onerror = e => {root.textContent = 'WORKER FAILED'; window.__workerError = e.message}",
				{
					headers: {
						'content-type': 'text/javascript',
						'cache-control': 'no-store',
					},
				},
			);
		}
		return new Response(
			'<!doctype html><html><head><title>Probe</title></head><body><p id="status">WAITING</p><script>window.__inline=1</script><script type="module" src="/app.js"></script></body></html>',
			{
				headers: {
					'content-type': 'text/html',
					'cache-control': 'no-store',
					'content-security-policy': "script-src 'self'",
				},
			},
		);
	},
});
