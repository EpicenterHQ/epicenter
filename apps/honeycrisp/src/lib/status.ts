/**
 * What a person is told about saving in the header's one line.
 *
 * Notes are kept in this device's local folder, which keeps no versions and
 * syncs nowhere, so saving is the only fact the header reports. A note is
 * saved when its text is on this device.
 */
import type { StatusLine } from '@epicenter/svelte/status-line';

/** The header's line, from the mirror's pending writes. */
export function saveLine(saving: boolean): StatusLine {
	if (saving) return { label: 'Saving…', tone: 'busy' };
	return { label: 'Saved on this device', short: 'Saved', tone: 'good' };
}
