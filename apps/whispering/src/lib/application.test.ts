/**
 * Document publication tests: imports acquire nothing, readiness gates access,
 * and departure prevents late publication or replacement of the document App.
 */
import { expect, mock, test } from 'bun:test';
import { createDeparture } from '@epicenter/app-shell/departure';
import { Ok } from 'wellcrafted/result';

let current: {
	app: { ready: Promise<{ error: unknown }> } | null;
	account: null;
	isClosing(): boolean;
	closeApp(): Promise<void>;
	departure: ReturnType<typeof createDeparture>;
};
let imports = 0;

async function setup(appReady: Promise<{ error: unknown }> | null) {
	let closes = 0;
	let closing = false;
	const closeApp = async () => {
		closing = true;
		closes++;
	};
	current = {
		app: appReady ? { ready: appReady } : null,
		account: null,
		isClosing: () => closing,
		closeApp,
		departure: createDeparture({ account: null, close: closeApp }),
	};
	mock.module('./bootstrap.js', () => {
		imports++;
		return current;
	});
	const application = await import(
		`./application.ts?case=${crypto.randomUUID()}`
	);
	return { application, closes: () => closes };
}

test('import acquires nothing and repeated opening publishes the same ready App', async () => {
	const before = imports;
	const ready = Promise.withResolvers<{ error: unknown }>();
	const { application } = await setup(ready.promise);
	expect(imports).toBe(before);
	expect(() => application.getApp()).toThrow();
	const first = application.openApplication();
	expect(application.openApplication()).toBe(first);
	const opened = await first;
	expect(() => application.getApp()).toThrow();
	ready.resolve(Ok(undefined));
	await ready.promise;
	expect(application.getApp()).toBe(opened.app);
	await opened.departure.close();
	expect(() => application.getApp()).toThrow();
	expect(await application.openApplication()).toBe(opened);
});

test('close during readiness prevents late publication', async () => {
	const ready = Promise.withResolvers<{ error: unknown }>();
	const { application, closes } = await setup(ready.promise);
	const opened = await application.openApplication();
	await opened.departure.close();
	ready.resolve(Ok(undefined));
	await ready.promise;
	expect(() => application.getApp()).toThrow();
	expect(closes()).toBe(1);
});

test('failed readiness never publishes or separately closes the App', async () => {
	const ready = Promise.withResolvers<{ error: unknown }>();
	const { application, closes } = await setup(ready.promise);
	const opened = await application.openApplication();
	ready.resolve({ error: new Error('storage failed') });
	await Bun.sleep(0);
	expect(() => application.getApp()).toThrow();
	// The concrete App owns opening-failure cleanup; this observer cannot
	// bypass retirement invalidation when readiness fails.
	expect(closes()).toBe(0);
	expect(opened.departure.state.phase).toBe('open');
});

test('connection-only opening publishes no library', async () => {
	const { application } = await setup(null);
	const opened = await application.openApplication();
	expect(opened.app).toBeNull();
	expect(() => application.getApp()).toThrow();
});

test('readiness during a refused departure leaves the App usable', async () => {
	const ready = Promise.withResolvers<{ error: unknown }>();
	const preflight = Promise.withResolvers<void>();
	const { application } = await setup(ready.promise);
	const opened = await application.openApplication();
	opened.departure.attachUi({
		preflight: () => preflight.promise,
		quiesce: async () => {},
	});
	const refused = opened.departure.close();
	const refusal = refused.catch((error: unknown) => error);
	await Promise.resolve();
	ready.resolve(Ok(undefined));
	await ready.promise;
	preflight.reject(new Error('recording'));
	expect(await refusal).toEqual(new Error('recording'));
	expect(opened.departure.state.phase).toBe('open');
	expect(application.getApp()).toBe(opened.app);
});

test('admitted work can read the App during UI drain but not after App close starts', async () => {
	const { application } = await setup(Promise.resolve(Ok(undefined)));
	const opened = await application.openApplication();
	const drain = Promise.withResolvers<void>();
	opened.departure.attachUi({ quiesce: () => drain.promise });
	const closing = opened.departure.close();
	await Bun.sleep(0);
	expect(opened.departure.state.phase).toBe('closing');
	expect(application.getApp()).toBe(opened.app);
	drain.resolve();
	await closing;
	expect(() => application.getApp()).toThrow();
});
