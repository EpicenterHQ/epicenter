/** Package acceptance page: actual browser resources and auth, without product UI. */

import { normalizeInstanceServer } from '@epicenter/auth';
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
				audio: field.attachment(),
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
	const bytes = expectOk(
		await bounded(app.tables.recordings.attachment(id).read()),
	);
	const context = new AudioContext();
	let decodedDuration: number;
	try {
		decodedDuration = (
			await bounded(context.decodeAudioData(await bytes.arrayBuffer()))
		).duration;
	} finally {
		await bounded(context.close());
	}
	const playback = expectOk(
		await bounded(app.tables.recordings.attachment(id).source()),
	);
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
	const table = app.tables.recordings;
	const actor = app.account?.principalId ?? 'local';
	const recording = expectOk(await bounded(app.recording.start({})));
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
		expectErr(await app.recording.start({})).name === 'AlreadyRecording',
		'Competing capture was admitted',
	);
	let meterTicks = 0;
	const unlevel = recording.onLevel(() => meterTicks++);
	await new Promise((resolve) => setTimeout(resolve, 450));
	const stopped = expectOk(await bounded(recording.stop()));
	const row = expectOk(
		await bounded(table.create({ title, actor, audio: stopped.file })),
	);
	expectOk(await app.recording.discard(stopped.file));
	const into = table.attachment(row.id);
	unlevel();
	assert(meterTicks > 0, 'Capture produced no meter events');
	const source = expectOk(await bounded(into.read()));
	assert(
		source.size === stopped.byteLength && source.size > 0,
		'Saved byte length differs',
	);
	const saved = await read(row.id);
	assert(
		saved.sha256 === (await digest(source)),
		'Attachment read changed the audio',
	);
	const ticksAfterStop = meterTicks;
	await new Promise((resolve) => setTimeout(resolve, 80));
	assert(meterTicks === ticksAfterStop, 'Meter continued after stop');
	assert(
		expectOk(await app.recording.current()) === null,
		'Stopped recording remains current',
	);
	return {
		rowId: row.id,
		replica: recording.replica,
		actor: row.actor,
		meterTicks,
		...saved,
	};
}

export async function absent(id: string) {
	assert(
		expectErr(await app.tables.recordings.attachment(id).read()).name ===
			'Unavailable',
		'Another library exposed recording bytes',
	);
	return true;
}

export async function waitForLocal(rowId: string) {
	for (let attempt = 0; attempt < 600; attempt++) {
		const status = app.attachments.status();
		const item = status.items.find((item) => item.rowId === rowId);
		if (item?.presence === 'local' && item.transfer === 'idle') return item;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(
		`Automatic attachment did not become local: ${JSON.stringify(app.attachments.status())}`,
	);
}

/** Valid mono PCM WAV import, including a representative three-minute file. */
export async function importAudio(seconds: number) {
	const sampleRate = 48_000;
	const buffer = new ArrayBuffer(44 + seconds * sampleRate * 2);
	const view = new DataView(buffer);
	const text = (offset: number, value: string) => {
		for (let index = 0; index < value.length; index++)
			view.setUint8(offset + index, value.charCodeAt(index));
	};
	text(0, 'RIFF');
	view.setUint32(4, buffer.byteLength - 8, true);
	text(8, 'WAVEfmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	text(36, 'data');
	view.setUint32(40, buffer.byteLength - 44, true);
	for (let sample = 0; sample < seconds * sampleRate; sample++)
		view.setInt16(
			44 + sample * 2,
			Math.round(Math.sin((sample * 2 * Math.PI * 440) / sampleRate) * 1000),
			true,
		);
	const audio = new Blob([buffer], { type: 'audio/wav' });
	const row = expectOk(
		await bounded(
			app.tables.recordings.create({
				title: `${seconds}-second imported WAV`,
				actor: app.account?.principalId ?? 'local',
				audio,
			}),
		),
	);
	return { rowId: row.id, byteLength: audio.size, sha256: await digest(audio) };
}

export async function closeWithCapture(id: string) {
	const rowsBefore = app.tables.recordings.ids();
	const playback = expectOk(
		await app.tables.recordings.attachment(id).source(),
	);
	const cancelled = expectOk(await app.recording.start({}));
	await new Promise((resolve) => setTimeout(resolve, 100));
	expectOk(await cancelled.cancel());
	assert(
		JSON.stringify(app.tables.recordings.ids()) === JSON.stringify(rowsBefore),
		'Cancel created a row',
	);
	const recording = expectOk(await app.recording.start({}));
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
		await retainedStart({});
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
		rowsBefore,
		retainedStartRefused: refused,
		meterStopped: true,
		playbackReleased,
	};
}

export function unchangedRows(ids: string[]) {
	assert(
		JSON.stringify(app.tables.recordings.ids()) === JSON.stringify(ids),
		'Unfinished capture created a durable row',
	);
	return true;
}
