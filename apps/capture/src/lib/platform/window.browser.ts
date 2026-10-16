/**
 * The browser leaf of the window seam: a tab has no close handler. Its leave
 * rule is the page's `beforeNavigate`, which raises the browser's own "Leave
 * site?". Nothing native is imported here.
 */
import type { OnCloseRequested } from './types.js';

export const onCloseRequested: OnCloseRequested | undefined = undefined;
