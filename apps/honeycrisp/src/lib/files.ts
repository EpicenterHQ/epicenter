/** App-owned file-name messages and the maximum size of editable text. */
import { type FolderFiles, pathProblem } from '@epicenter/folder';
import {
	joinPath,
	readTextFile as readFolderTextFile,
} from '@epicenter/folder/file-browser';

/**
 * Why the folder refused `name`, in a person's words. The folder's path rule
 * (`pathProblem`) decides; this is asked only about a name it refused, and
 * names the part of the rule the name broke.
 */
function refusedName(name: string): string | undefined {
	if (/[. ]$/.test(name))
		return 'A name cannot end with a dot or a space. Windows drops them, so the name would mean another file.';
	if (/[<>:"|?*]/.test(name))
		return 'A name cannot contain < > : " | ? or *. Windows does not allow them.';
	if (name.toLowerCase() === '.git')
		return '".git" is where Git keeps its history.';
	if (name.toUpperCase() === 'HEAD')
		return '"HEAD" is a name Git keeps for itself.';
	if (/~[0-9]/.test(name))
		return 'A name cannot contain "~" followed by a digit. Windows uses that for short names, so the name could mean another file.';
	const stem = (name.split('.')[0] ?? '').trimEnd().toUpperCase();
	if (/^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(COM|LPT)[0-9¹²³])$/.test(stem))
		return `"${name}" is a name Windows keeps for a device.`;
	return undefined;
}

export function nameProblem(
	directory: string,
	name: string,
): string | undefined {
	if (name === '') return 'Enter a name.';
	if (name.includes('/')) return 'A name cannot contain "/".';
	const problem = pathProblem(joinPath(directory, name));
	if (problem === undefined) return undefined;
	return refusedName(name) ?? `This name is not usable: ${problem}.`;
}

/** Text larger than this opens as file details instead of in the editor. */
export const EDITABLE_TEXT_LIMIT = 1024 * 1024;

/** Read editable text using this app's size limit. */
export function readTextFile(files: Pick<FolderFiles, 'read'>, path: string) {
	return readFolderTextFile(files, path, EDITABLE_TEXT_LIMIT);
}
