/**
 * The Epicenter host leaf of the close seam: this window hears the host's
 * flush before it quits or restarts (`@epicenter/epicenter/page-close`).
 * Imports register nothing; the page listens when it mounts.
 */

import { onHostClose } from '@epicenter/epicenter/page-close';
import type { HostCloseSignal } from '@epicenter/svelte/flush-on-close';

export const hostClose: HostCloseSignal | undefined = onHostClose;
