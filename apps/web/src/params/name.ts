import { NAME } from '$lib/name.js';

/** An owner or repository name: a letter, then letters, digits and `-`. Shell pages live under `/-/`, which no name can be. */
export const match = (segment: string) => NAME.test(segment);
