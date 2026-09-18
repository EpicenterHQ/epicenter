/** Real browser App lifetime, with one opt-in document cleanup failure. */
import { defineApp, defineTable, field } from '../../../src/index.js';
import { openApp } from '../../../src/open.js';
import { resources } from '../../../src/platform/browser.js';

const definition = defineApp({
	id:
		new URL(location.href).searchParams.get('appId') ??
		'so.epicenter.admission-evidence',
	tables: { notes: defineTable({ title: field.string() }) },
	kv: {},
});
let failCleanup = false;
const runtime = {
	...resources,
	async data(...args: Parameters<typeof resources.data>) {
		const result = await resources.data(...args);
		if (result.error) return result;
		const port = result.data;
		return {
			...result,
			data: {
				...port,
				async dispose() {
					if (failCleanup) throw new Error('Injected document cleanup failure');
					await port.dispose?.();
				},
			},
		};
	},
};
let app: ReturnType<typeof openApp<typeof definition, undefined>> | undefined;

Object.assign(globalThis, {
	async openEvidence() {
		app = openApp(definition, { runtime });
		const result = await app.ready;
		return result.error?.name ?? 'ready';
	},
	async closeEvidence() {
		try {
			await app?.close();
			return 'closed';
		} catch {
			return 'cleanup-failed';
		}
	},
	async writeEvidence() {
		const row = app!.device.tables.notes.create({ title: 'retained' });
		await app!.device.persistence.flush();
		return row.id;
	},
	readEvidence() {
		return app!.device.tables.notes
			.ids()
			.map((id) => app!.device.tables.notes.get(id)?.title);
	},
	setCleanupFailure(value: boolean) {
		failCleanup = value;
	},
});
