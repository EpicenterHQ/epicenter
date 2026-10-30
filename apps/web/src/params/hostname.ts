import { isHostname } from '@epicenter/app';

/** An app's segment: the hostname it is served at the root of (ADR-0694), which no owner or repository name can be. */
export const match = (segment: string) => isHostname(segment);
