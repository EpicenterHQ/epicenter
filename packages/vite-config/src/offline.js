/** Cache a published SPA's static files while leaving data and IPC requests alone. */
export function cacheSite(scope, { base, build, files, version }) {
	const prefix = 'epicenter-site-';
	const name = `${prefix}${version}`;
	const home = `${base}/`;
	const staticFiles = new Set([...build, ...files]);

	scope.addEventListener('install', (event) => {
		event.waitUntil(caches.open(name).then((cache) => cache.addAll([home, ...staticFiles])));
	});

	scope.addEventListener('activate', (event) => {
		event.waitUntil(
			caches.keys().then(async (keys) => {
				for (const key of keys) {
					if (key.startsWith(prefix) && key !== name) await caches.delete(key);
				}
			}),
		);
	});

	scope.addEventListener('fetch', (event) => {
		const request = event.request;
		if (request.method !== 'GET') return;
		const url = new URL(request.url);
		if (url.origin !== scope.location.origin) return;

		event.respondWith(
			(async () => {
				const cache = await caches.open(name);
				if (staticFiles.has(url.pathname)) {
					const cached = await cache.match(url.pathname);
					if (cached) return cached;
				}
				try {
					return await fetch(request);
				} catch (error) {
					if (request.mode === 'navigate') {
						const cached = await cache.match(home);
						if (cached) return cached;
					}
					throw error;
				}
			})(),
		);
	});
}
