/** The worker is served at origin root by Epicenter and the browser build. */
export async function preparePlaybackWorker() {
	if (!navigator.serviceWorker)
		throw new Error('This environment cannot stream Personal audio.');
	const intended = new URL('/epicenter-blob-worker.js', location.origin).href;
	const controlsPage = () =>
		navigator.serviceWorker.controller?.scriptURL === intended;
	await navigator.serviceWorker.register('/epicenter-blob-worker.js', {
		scope: '/',
	});
	if (controlsPage()) return;
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			reject(
				new Error(
					'The audio playback worker did not take control. Reload to retry.',
				),
			);
		}, 10_000);
		function cleanup() {
			clearTimeout(timeout);
			navigator.serviceWorker.removeEventListener('controllerchange', changed);
		}
		function changed() {
			if (controlsPage()) {
				cleanup();
				resolve();
			}
		}
		navigator.serviceWorker.addEventListener('controllerchange', changed);
		changed();
	});
}
