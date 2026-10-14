/**
 * The application every bundle test builds. It imports the bare package and
 * nothing else, as ordinary application code does. Which adapter a build
 * carries is decided by the build's alias, never by this file.
 */
import {
	defineFolder,
	defineTable,
	field,
	openFolder,
} from '@epicenter/folder';

const definition = defineFolder({
	kv: {},
	tables: { notes: defineTable({ fields: { title: field.string() } }) },
});

export async function start() {
	const { data: folder, error: openError } = await openFolder({
		id: 'so.epicenter.bundlefixture',
		definition,
	});
	if (openError !== null) return openError.name;
	return folder.location.kind;
}
