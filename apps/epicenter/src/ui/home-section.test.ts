/**
 * Home Section Tests
 *
 * How Settings follows the section an app asked the shell to open.
 *
 * Key behaviors:
 * - A request made before Settings opened is shown when it mounts
 * - A nudge claims the request again and shows it; an empty claim shows nothing
 * - The first claim waits until the nudge is heard, so no request falls between
 * - After stop, nothing is shown and the listener is removed
 */
import { expect, test } from 'bun:test';
import type { HomeSection } from './bindings.gen';
import { followHomeSections } from './home-section.ts';

/** A shell holding at most one request, as `PendingHomeSection` does. */
function shell(pending: HomeSection | null = null) {
	let request = pending;
	let nudge: (() => void) | undefined;
	let listening = false;
	return {
		request(section: HomeSection) {
			request = section;
			nudge?.();
		},
		claim: async () => {
			const taken = request;
			request = null;
			return taken;
		},
		onNudge: async (nudged: () => void) => {
			nudge = nudged;
			listening = true;
			return () => {
				nudge = undefined;
				listening = false;
			};
		},
		get listening() {
			return listening;
		},
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a request made before Settings opened is shown when it mounts', async () => {
	const host = shell('transcription');
	const shown: HomeSection[] = [];
	followHomeSections({ ...host, show: (section) => shown.push(section) });
	await settle();
	expect(shown).toEqual(['transcription']);
});

test('a nudge shows the request it announces, once', async () => {
	const host = shell();
	const shown: HomeSection[] = [];
	followHomeSections({ ...host, show: (section) => shown.push(section) });
	await settle();
	expect(shown).toEqual([]);

	host.request('transcription');
	await settle();
	expect(shown).toEqual(['transcription']);
});

test('the first claim waits until the nudge is heard', async () => {
	const host = shell();
	const order: string[] = [];
	followHomeSections({
		claim: async () => {
			order.push('claim');
			return null;
		},
		onNudge: async (nudged) => {
			await settle();
			order.push('listening');
			return host.onNudge(nudged);
		},
		show: () => undefined,
	});
	await settle();
	await settle();
	expect(order).toEqual(['listening', 'claim']);
});

test('after stop, a nudge shows nothing and the listener is removed', async () => {
	const host = shell();
	const shown: HomeSection[] = [];
	const stop = followHomeSections({
		...host,
		show: (section) => shown.push(section),
	});
	await settle();
	expect(host.listening).toBe(true);

	stop();
	await settle();
	host.request('transcription');
	await settle();
	expect(shown).toEqual([]);
	expect(host.listening).toBe(false);
});
