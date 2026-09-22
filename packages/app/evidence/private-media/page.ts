import { asPrincipalId } from '@epicenter/principal';
import { createSessionAuth } from '../../../auth/src/create-session-auth.js';
import { createDesktopBrokerAuth } from '../../../auth/src/desktop-broker-auth.js';
import { parseBlobId } from '../../../blobs/src/blob-id.js';
import { createRemoteBlobAccess } from '../../../blobs/src/owner.js';
import { createRemoteBlobClient } from '../../../client/src/index.js';

const desktop = !!document.getElementById('epicenter-auth-bootstrap');
const auth = desktop
	? createDesktopBrokerAuth({ brokerBaseURL: location.origin })
	: createSessionAuth({
			authorityId: 'media-evidence',
			baseURL: document.documentElement.dataset.api!,
			persistedAuthStorage: {
				initial: { token: 'alice', principalId: asPrincipalId('alice') },
				async set() {},
			},
			launcher: {
				async startSignIn() {
					return { status: 'completed', token: 'bob' };
				},
			},
		});
const captured = auth.getState().account!;
const observed: unknown[] = [];
const account = {
	...captured,
	async fetch(...args: Parameters<typeof captured.fetch>) {
		const response = await captured.fetch(...args);
		observed.push({
			method: args[1]?.method,
			status: response.status,
			headers: Object.fromEntries(response.headers),
		});
		return response;
	},
};
const owner = createRemoteBlobAccess({
	remote: createRemoteBlobClient({ appId: 'test.media', account }),
});
const id = parseBlobId(document.documentElement.dataset.blob!)!;
const missingWorker = (await owner.value.open(id)).error !== null;
await navigator.serviceWorker.register('/epicenter-blob-worker.js');
await navigator.serviceWorker.ready;
if (!navigator.serviceWorker.controller)
	await new Promise<void>((resolve) =>
		navigator.serviceWorker.addEventListener(
			'controllerchange',
			() => resolve(),
			{ once: true },
		),
	);
const opened = await owner.value.open(id);
if (opened.error) throw new Error(opened.error.message);
const source = opened.data;
function assert(value: unknown, message: string) {
	if (!value) throw new Error(message);
}
function event(target: EventTarget, name: string) {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error('Timed out: ' + name)),
			15000,
		);
		target.addEventListener(
			name,
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
		target.addEventListener(
			'error',
			() => {
				clearTimeout(timer);
				reject(new Error('Media error'));
			},
			{ once: true },
		);
	});
}
Object.assign(globalThis, {
	mediaEvidence: {
		url: source.url,
		async run() {
			Object.assign(globalThis, { mediaProgress: 'const head = await' });
			const head = await fetch(source.url, { method: 'HEAD' });
			const partial = await fetch(source.url, {
				headers: { range: 'bytes=0-3' },
			});
			const bytes = await partial.text();
			const unsatisfied = await fetch(source.url, {
				headers: { range: 'bytes=999999999-' },
			});
			const first = await fetch(source.url);
			const reader = first.body!.getReader();
			const chunk = await reader.read();
			await reader.cancel();
			assert(
				chunk.value &&
					chunk.value.length < Number(head.headers.get('content-length')),
				JSON.stringify({
					head: head.status,
					partial: partial.status,
					bytes,
					first: first.status,
					chunk,
					observed,
				}),
			);
			const firstPlayStarted = performance.now();
			Object.assign(globalThis, { mediaProgress: 'const audio = document' });
			const audio = document.createElement('audio');
			audio.muted = true;
			document.body.append(audio);
			const metadata = event(audio, 'loadedmetadata');
			audio.src = source.url;
			await metadata;
			const moving = event(audio, 'timeupdate');
			await audio.play();
			await moving;
			const playedAt = audio.currentTime;
			const firstPlayMs = performance.now() - firstPlayStarted;
			const seek = event(audio, 'seeked');
			audio.currentTime = audio.duration - 2;
			await seek;
			const soughtTo = audio.currentTime;
			audio.pause();
			audio.removeAttribute('src');
			audio.load();
			audio.remove();
			let safeContent = 0;
			for (const key of [
				document.documentElement.dataset.html!,
				document.documentElement.dataset.svg!,
			]) {
				const unsafe = await owner.value.open(parseBlobId(key)!);
				if (unsafe.error) throw unsafe.error;
				const response = await fetch(unsafe.data.url);
				assert(
					response.headers.get('content-security-policy') ===
						"sandbox; default-src 'none'" &&
						response.headers.get('x-content-type-options') === 'nosniff' &&
						response.headers.get('content-disposition') === 'attachment',
					'Unsafe content serving headers',
				);
				await response.text();
				const frame = document.createElement('iframe');
				const loaded = event(frame, 'load');
				frame.src = unsafe.data.url;
				document.body.append(frame);
				await loaded;
				assert(
					!(globalThis as { pwned?: boolean }).pwned,
					'Untrusted document executed',
				);
				frame.remove();
				unsafe.data[Symbol.dispose]();
				safeContent++;
			}
			const second = await owner.value.open(id);
			if (second.error) throw second.error;
			Object.assign(globalThis, { mediaProgress: 'source[Symbol.dispose]();' });
			source[Symbol.dispose]();
			const disposed = await fetch(source.url);
			Object.assign(globalThis, { mediaProgress: 'const independent = await' });
			const independent = await fetch(second.data.url, { method: 'HEAD' });
			Object.assign(globalThis, { mediaProgress: 'const now = Date.now' });
			const now = Date.now;
			Date.now = () => now() + 300001;
			const expired = await fetch(second.data.url, { method: 'HEAD' });
			Date.now = now;
			second.data[Symbol.dispose]();
			Object.assign(globalThis, { mediaProgress: 'const versioned = await' });
			const versioned = await owner.value.open(id);
			if (versioned.error) throw versioned.error;
			await account.fetch(new URL('/api/evidence/version', account.baseURL), {
				method: 'POST',
			});
			const changed = await fetch(versioned.data.url, {
				headers: { range: 'bytes=0-3' },
			});
			versioned.data[Symbol.dispose]();
			Object.assign(globalThis, { mediaProgress: 'const retiring = await' });
			const retiring = await owner.value.open(id);
			if (retiring.error) throw retiring.error;
			Object.assign(globalThis, { mediaProgress: 'await auth.signOut();' });
			await auth.signOut();
			if (!desktop) await auth.startSignIn();
			Object.assign(globalThis, { mediaProgress: 'const retired = await' });
			const retired = await fetch(retiring.data.url, {
				headers: { range: 'bytes=4-7' },
			});
			Object.assign(globalThis, { mediaProgress: 'await owner.close();' });
			await owner.close();
			Object.assign(globalThis, { mediaProgress: 'const result = {' });
			const result = {
				desktop,
				missingWorker,
				safeContent,
				head: head.status,
				length: head.headers.get('content-length'),
				partial: partial.status,
				bytes,
				unsatisfied: unsatisfied.status,
				firstChunk: chunk.value?.length,
				firstPlayMs,
				playedAt,
				soughtTo,
				disposed: disposed.status,
				independent: independent.status,
				expired: expired.status,
				changed: changed.status,
				retired: retired.status,
			};
			assert(
				head.status === 200 &&
					partial.status === 206 &&
					bytes === 'RIFF' &&
					unsatisfied.status === 416 &&
					playedAt > 0 &&
					soughtTo > 100 &&
					disposed.status === 410 &&
					independent.status === 200 &&
					expired.status === 410 &&
					changed.status === 410 &&
					retired.status === 410,
				JSON.stringify(result),
			);
			return result;
		},
	},
});
