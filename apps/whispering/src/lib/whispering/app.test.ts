/**
 * Whispering domains recover defaults, notify readers, retain settings across
 * reopening the same runtime, and stop subscriptions when disposed.
 */
import { expect, test } from 'bun:test';
import { openApp } from '@epicenter/app/open';
import { createMemoryRuntime } from '@epicenter/app/testing';
import { expectOk } from 'wellcrafted/testing';
import { whisperingDefinition } from '../data.js';
import { createWhisperingDomains } from './app.js';

Reflect.set(
	globalThis,
	'$state',
	Object.assign(<T>(value: T) => value, { raw: <T>(value: T) => value }),
);
Reflect.set(
	globalThis,
	'$derived',
	Object.assign(<T>(value: T) => value, {
		by: <T>(derive: () => T) => derive(),
	}),
);

async function openWhispering(runtime: ReturnType<typeof createMemoryRuntime>) {
	const app = await openApp(whisperingDefinition, { runtime });
	return app;
}

test('settings recover application defaults, notify, and survive a reopen', async () => {
	const runtime = createMemoryRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	{
		const openedApp = await openWhispering(runtime);
		const app = createWhisperingDomains({
			openedApp,
			data: openedApp.device,
		});

		// Chosen by the application, applied by a read, never stored.
		expect(app.settings.get('transcriptionModel')).toBe('');
		expect(app.settings.get('recordingPausePlayback')).toBe(false);
		expect(app.settings.get('soundManualStart')).toBe(true);

		let notifications = 0;
		const stop = app.settings.subscribe(() => {
			notifications += 1;
		});
		app.settings.set('recordingPausePlayback', true);
		expect(app.settings.get('recordingPausePlayback')).toBe(true);
		expect(notifications).toBeGreaterThan(0);
		stop();

		app[Symbol.dispose]();
		await openedApp.close();
	}

	// Reopening the same runtime restores the settings written above.
	const openedApp = await openWhispering(runtime);
	const reopened = createWhisperingDomains({
		openedApp,
		data: openedApp.device,
	});

	expect(reopened.settings.get('recordingPausePlayback')).toBe(true);

	reopened[Symbol.dispose]();
	await openedApp.close();
});

test('the domains stop reading the store once they are disposed', async () => {
	// Disposal is on the value `createWhisperingDomains` returns and not on
	// `WhisperingApp`, so the session that built the domains is the only thing
	// that can end them: a component reading the app through context has no
	// `[Symbol.dispose]` to reach for.
	const runtime = createMemoryRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const openedApp = await openWhispering(runtime);
	const app = createWhisperingDomains({
		openedApp,
		data: openedApp.device,
	});

	app[Symbol.dispose]();
	let notifications = 0;
	app.settings.subscribe(() => {
		notifications += 1;
	});
	openedApp.device.kv.update({ recordingPausePlayback: true });

	expect(notifications).toBe(0);
	await openedApp.close();
});
