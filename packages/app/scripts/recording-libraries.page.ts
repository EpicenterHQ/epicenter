/** Package acceptance page: actual browser resources and auth, without product UI. */

import { normalizeInstanceServer } from '@epicenter/auth';
import { parseBlobId } from '@epicenter/blobs';
import { defineData, defineTable, field } from '@epicenter/data/definition';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createBrowserRedirectAuth } from '../../auth/src/browser-redirect-auth.js';
import { defineApplication } from '../src/index.js';

export const appId = 'so.epicenter.recording-acceptance';
const application = defineApplication({
	appId,
	definition: defineData({
		id: appId,
		tables: {
			recordings: defineTable({
				title: field.string(),
				actor: field.string(),
				audio: field.blob(),
			}),
		},
		kv: {},
	}),
});
export let auth: ReturnType<typeof createBrowserRedirectAuth>;
export let app: ReturnType<typeof application.openLocal>;
export let library: 'local' | 'personal' | 'shared';

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function bounded<T>(operation: Promise<T>) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error('Browser operation timed out')),
					20_000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

export async function boot(server: string) {
	auth = createBrowserRedirectAuth({
		appId,
		...normalizeInstanceServer(server),
	});
	if (location.pathname === '/auth/callback') {
		expectOk(await bounded(auth.completeSignIn()));
		location.replace('/');
		return;
	}
	const selected = localStorage.getItem(`${appId}.library`);
	library =
		selected === 'shared' || selected === 'personal' ? selected : 'local';
	if (library === 'local') app = application.openLocal();
	else {
		assert(
			auth.state.status !== 'signed-out',
			'Account library requires sign-in',
		);
		app =
			library === 'personal'
				? application.openPersonal(auth.state.account)
				: application.openShared(auth.state.account);
	}
	expectOk(await bounded(app.ready));
	document.body.dataset.ready = library;
	const status = document.querySelector('p');
	assert(status, 'Acceptance page has no status element');
	status.textContent = `Package acceptance: ${library}, ${app.account?.principalId ?? 'signed out'}`;
}

export async function signIn() {
	await bounded(app.close());
	localStorage.setItem(`${appId}.library`, 'personal');
	expectOk(await bounded(auth.startSignIn()));
}

export async function select(next: typeof library) {
	const previous = library;
	await bounded(app.close());
	assert(app.signal.aborted, 'Library close did not revoke admission');
	sessionStorage.setItem('closed-library', previous);
	localStorage.setItem(`${appId}.library`, next);
}

async function digest(blob: Blob) {
	const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
	return Array.from(new Uint8Array(hash), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('');
}

export async function read(id: string) {
	const blobId = parseBlobId(id);
	assert(blobId, 'Invalid recording blob ID');
	const bytes = expectOk(await bounded(app.blobs.get(blobId)));
	const context = new AudioContext();
	let decodedDuration: number;
	try {
		decodedDuration = (
			await bounded(context.decodeAudioData(await bytes.arrayBuffer()))
		).duration;
	} finally {
		await bounded(context.close());
	}
	const playback = expectOk(await bounded(app.blobs.open(blobId)));
	const audio = document.createElement('audio');
	audio.controls = true;
	audio.src = playback.url;
	document.body.append(audio);
	try {
		await bounded(audio.play());
		await new Promise((resolve) => setTimeout(resolve, 120));
		assert(
			audio.currentTime > 0,
			'Media element did not play the saved recording',
		);
	} finally {
		audio.pause();
		audio.removeAttribute('src');
		audio.load();
		audio.remove();
		playback[Symbol.dispose]();
	}
	assert(decodedDuration > 0, 'Saved recording did not decode');
	return {
		byteLength: bytes.size,
		contentType: bytes.type,
		sha256: await digest(bytes),
		decodedDuration,
		played: true,
	};
}

export async function capture(title: string) {
	const recording = expectOk(await bounded(app.recording.start()));
	assert(
		recording.replica.library === library,
		'Recording selected a different library',
	);
	if (recording.replica.library !== 'local') {
		assert(
			recording.replica.account.principalId === app.account?.principalId,
			'Recording replaced the authenticated actor',
		);
	}
	assert(
		expectErr(await app.recording.start()).name === 'AlreadyRecording',
		'Competing capture was admitted',
	);
	let meterTicks = 0;
	const unlevel = recording.onLevel(() => meterTicks++);
	await new Promise((resolve) => setTimeout(resolve, 450));
	const stopped = expectOk(await bounded(recording.stop()));
	unlevel();
	assert(meterTicks > 0, 'Capture produced no meter events');
	const source = expectOk(await bounded(app.blobs.get(stopped.audioBlobId)));
	assert(
		source.size === stopped.byteLength && source.size > 0,
		'Saved byte length differs',
	);
	const row = expectOk(
		await bounded(
			app.tables.recordings.create({
				title,
				actor: app.account?.principalId ?? 'local',
				audio: stopped.audioBlobId,
			}),
		),
	);
	const saved = await read(row.audio);
	assert(
		saved.sha256 === (await digest(source)),
		'Attachment creation changed the audio',
	);
	expectOk(await app.blobs.removeLocal(stopped.audioBlobId));
	const ticksAfterStop = meterTicks;
	await new Promise((resolve) => setTimeout(resolve, 80));
	assert(meterTicks === ticksAfterStop, 'Meter continued after stop');
	assert(
		expectOk(await app.recording.current()) === null,
		'Stopped recording remains current',
	);
	return {
		rowId: row.id,
		audioBlobId: row.audio,
		replica: recording.replica,
		actor: row.actor,
		meterTicks,
		...saved,
	};
}

export async function absent(id: string) {
	const blobId = parseBlobId(id);
	assert(blobId, 'Invalid recording blob ID');
	assert(
		expectErr(await app.blobs.stat(blobId)).name === 'BlobNotFound',
		'Another library exposed recording bytes',
	);
	return true;
}

export async function closeWithCapture(id: string) {
	const blobId = parseBlobId(id);
	assert(blobId, 'Invalid recording blob ID');
	const playback = expectOk(await app.blobs.open(blobId));
	const cancelled = expectOk(await app.recording.start());
	await new Promise((resolve) => setTimeout(resolve, 100));
	expectOk(await cancelled.cancel());
	await absent(cancelled.audioBlobId);
	const recording = expectOk(await app.recording.start());
	let ticks = 0;
	recording.onLevel(() => ticks++);
	await new Promise((resolve) => setTimeout(resolve, 100));
	const retainedStart = app.recording.start;
	const closing = app.close();
	assert(closing === app.close(), 'Repeated close changed its completion');
	await bounded(closing);
	assert(app.signal.aborted, 'Close did not revoke App admission');
	let refused = false;
	try {
		await retainedStart();
	} catch {
		refused = true;
	}
	assert(refused, 'Retained recorder admitted work after close');
	const ticksAfterClose = ticks;
	await new Promise((resolve) => setTimeout(resolve, 80));
	assert(ticks === ticksAfterClose, 'Closed recording continued metering');
	const playbackReleased = await fetch(playback.url).then(
		() => false,
		() => true,
	);
	assert(playbackReleased, 'Close retained a playback URL');
	playback[Symbol.dispose]();
	return {
		cancelled: cancelled.audioBlobId,
		closedCapture: recording.audioBlobId,
		retainedStartRefused: refused,
		meterStopped: true,
		playbackReleased,
	};
}
