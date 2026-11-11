import { toast } from 'svelte-sonner';
import type { AnyTaggedError } from 'wellcrafted/error';
import { isResult, type Result } from 'wellcrafted/result';

/**
 * Show an error toast and pass through the value unchanged.
 *
 * Accepts either a full `Result` or a bare tagged error. When given a Result,
 * it toasts only if the error branch is present. When given a bare error, it
 * always toasts. Either way the input is returned unchanged, so you can wrap
 * expressions or slot it into `return` statements without disrupting control flow.
 *
 * The title appears as the bold headline. The error's `.message`, typically the
 * detailed output from `defineErrors`, is shown as the muted description below.
 *
 * @param resultOrError - A `Result` to inspect, or a bare tagged error to toast
 * @param title - Human-readable headline shown in the toast
 * @returns The same `resultOrError`, unchanged
 *
 * @example
 * ```typescript
 * // Destructure first, toast and return in one expression (preferred)
 * const { data, error } = await api.billing.portal();
 * if (error) return toastOnError(error, 'Could not open billing portal');
 *
 * // Fire-and-forget in onclick handlers
 * bookmarkState.toggle(tab).then((r) => toastOnError(r, 'Failed to toggle bookmark'));
 * ```
 */
export function toastOnError<
	TInput extends Result<unknown, AnyTaggedError> | AnyTaggedError,
>(resultOrError: TInput, title: string): TInput {
	if (isResult<unknown, AnyTaggedError>(resultOrError)) {
		if (resultOrError.error !== null) {
			toast.error(title, { description: resultOrError.error.message });
		}
		return resultOrError;
	}
	toast.error(title, { description: resultOrError.message });
	return resultOrError;
}
