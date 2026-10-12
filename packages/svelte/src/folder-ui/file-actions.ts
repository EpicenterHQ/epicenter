/** Plain helpers the file views and the apps around them share. */

import { toast } from '@epicenter/ui/sonner';

/** Copy a path to the clipboard, and say whether it worked. */
export async function copyPath(path: string) {
	try {
		await navigator.clipboard.writeText(path);
		toast.success(`Copied ${path}`);
	} catch {
		toast.error('Could not copy the path', { description: path });
	}
}

/** A file shown as details: its extension names the type, then its size. */
export function fileDetails(name: string, size: number) {
	const dot = name.lastIndexOf('.');
	const kind = dot > 0 ? `${name.slice(dot + 1).toUpperCase()} file` : 'File';
	if (size < 1024) return `${kind} · ${size} ${size === 1 ? 'byte' : 'bytes'}`;
	if (size < 1024 * 1024) return `${kind} · ${(size / 1024).toFixed(1)} KB`;
	return `${kind} · ${(size / (1024 * 1024)).toFixed(1)} MB`;
}
