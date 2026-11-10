/** File names that stay on this computer, at any depth in an app. */
export const LOCAL_NAMES = ['*.local', '*.local.*'] as const;

/** Whether any segment of a relative app path has a local-only name. */
export function isLocalPath(path: string): boolean {
	return path
		.split('/')
		.some((part) => part.endsWith('.local') || part.includes('.local.'));
}
