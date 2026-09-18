import { clipboard } from '@epicenter/app/clipboard';
import type { CopyFn } from '@epicenter/ui/copy-button';
import { report } from '$lib/report';

/**
 * Creates a copy function with toast notifications.
 *
 * @param contentDescription - Description of what's being copied (e.g., "transcript", "API key")
 *                            Used in toast messages like "Copied {contentDescription} to clipboard!"
 *
 * @example
 * ```svelte
 * <CopyButton
 *   text={transcribedText}
 *   copyFn={createCopyFn('transcript')}
 * >
 *   <CopyIcon class="size-4" />
 * </CopyButton>
 * ```
 */
export function createCopyFn(contentDescription: string): CopyFn {
	return async (text: string) => {
		const { error } = await clipboard.writeText(text);
		if (error) {
			report.error({
				title: `Error copying ${contentDescription} to clipboard`,
				cause: error,
			});
			throw error;
		}
		report.success({
			title: `Copied ${contentDescription} to clipboard!`,
			description: text,
		});
	};
}
