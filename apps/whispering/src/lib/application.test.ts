import { expect, mock, test } from 'bun:test';

let imports = 0;
async function setup(
	opening: Promise<{ app: object; data: object }> | undefined,
) {
	const bootstrap = { opening, selections: {} };
	mock.module('./bootstrap.js', () => {
		imports++;
		return bootstrap;
	});
	const application = await import(
		`./application.ts?case=${crypto.randomUUID()}`
	);
	return { application, bootstrap };
}

test('imports acquire nothing and one opening promise publishes only its ready handle', async () => {
	const before = imports;
	const pending = Promise.withResolvers<{ app: object; data: object }>();
	const { application, bootstrap } = await setup(pending.promise);
	expect(imports).toBe(before);
	expect(() => application.getApp()).toThrow();
	const first = application.openApplication();
	expect(application.openApplication()).toBe(first);
	await first;
	expect(() => application.getApp()).toThrow();
	const lifetime = new AbortController();
	const app = { signal: lifetime.signal };
	pending.resolve({ app, data: {} });
	await pending.promise;
	expect(application.getApp()).toBe(app);
	expect(application.getSelections()).toBe(bootstrap.selections);
	lifetime.abort();
	expect(() => application.getApp()).toThrow();
	expect(application.openApplication()).toBe(first);
});

test('failed opening never publishes a handle or retries acquisition', async () => {
	const pending = Promise.withResolvers<{ app: object; data: object }>();
	const { application } = await setup(pending.promise);
	const first = application.openApplication();
	await first;
	pending.reject(Error('opening failed'));
	await Bun.sleep(0);
	expect(() => application.getApp()).toThrow();
	expect(application.openApplication()).toBe(first);
});

test('connection-only page never exposes an App', async () => {
	const { application } = await setup(undefined);
	await application.openApplication();
	expect(() => application.getApp()).toThrow();
	expect(() => application.getSelections()).toThrow();
});
