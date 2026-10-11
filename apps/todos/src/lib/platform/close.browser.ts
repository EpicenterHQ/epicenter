/**
 * The browser leaf of the close seam: no host signal. A closing tab flushes on
 * `pagehide`, and the leave warning covers a save still running or failed.
 * Nothing native is imported here.
 */
import type { HostCloseSignal } from '@epicenter/svelte/flush-on-close';

export const hostClose: HostCloseSignal | undefined = undefined;
