import { createPortableTarMaterializer } from '../../src/epicenter-sync/portable-tar-materializer.js';

const materialize = createPortableTarMaterializer({ fetch });

Bun.serve({
	port: 8080,
	fetch(request) {
		if (new URL(request.url).pathname === '/health') {
			return new Response('ok');
		}
		return materialize(request);
	},
});
