/**
 * The application every bundle test builds. It imports the bare package and
 * nothing else, as ordinary application code does. Which engine a build
 * carries is decided by the build's alias, never by this file.
 */
import { openFolder } from '@epicenter/folder';
import { Type } from 'typebox';

const notes = Type.Object({ title: Type.String() });

export async function start() {
	const { data: folder, error: openError } = await openFolder({
		tables: { notes },
	});
	if (openError !== null) return openError.name;
	await folder.close();
	return 'so.epicenter.bundlefixture';
}
