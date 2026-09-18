import type { createWorkingCopy } from '@epicenter/app/artifact/checkout';

/**
 * There is no `~/Epicenter` folder in a browser tab.
 *
 * A page has no filesystem, so there is nothing for a checkout to land in and
 * no route that could take one. The build answers this, not a runtime probe:
 * a person in an ordinary browser never meets the button, rather than meeting
 * one that always fails.
 *
 * Typed as the capability it is missing rather than as `undefined`, so both
 * leaves state one contract and a caller writes `openWorkingCopy?.(data)`
 * whichever build it is reading.
 */
export const openWorkingCopy: typeof createWorkingCopy | undefined = undefined;
