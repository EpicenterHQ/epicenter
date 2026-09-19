/** Real App writes through IndexedDB in an admitted native application window. */
import { defineApp, defineTable, field } from '@epicenter/app';
import { openApp } from '@epicenter/app/open';
import { invoke } from '@tauri-apps/api/core';

try {
	const { cycle, document } = await invoke<{ cycle: number; document: number }>(
		'evidence_boot',
	);
	const app = await openApp(
		defineApp({
			id: 'so.epicenter.runtimeevidence',
			kv: {},
			tables: { markers: defineTable({ value: field.number() }) },
		}),
	);
	const values = app.device.tables.markers.rows
		.map((row) => row.value)
		.sort((a, b) => a - b);
	const expected = cycle + (document === 1 ? 1 : 0);
	if (
		values.length !== expected ||
		values.some((value, index) => value !== index)
	)
		throw new Error(
			`cycle=${cycle} document=${document}: expected ${expected} committed markers, got ${JSON.stringify(values)}`,
		);
	if (document === 0 && cycle < 20) {
		app.device.tables.markers.create({ value: cycle });
		await app.device.persistence.flush();
		if (app.device.persistence.get() !== 'saved')
			throw new Error('marker was not committed');
	}
	// Intentionally no App.close: the document and process are interrupted.
	await invoke('evidence_result', { error: null });
} catch (error) {
	await invoke('evidence_result', { error: String(error) });
}
