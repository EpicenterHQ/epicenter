/** App-owned file-name messages. */
import { joinPath, pathProblem } from '@epicenter/folder/file-browser';

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
	if (/^[^ .]{1,6}~[0-9]+(\.[^ .]{1,3})?$/u.test(name))
		return 'A name cannot look like a Windows short name such as "NOTES~1". Windows uses those for other files.';
	const stem = (name.split('.')[0] ?? '').replace(/ +$/, '').toUpperCase();
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
