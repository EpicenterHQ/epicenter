import { NAME } from '$lib/name.js';

/** An owner or repository name: a letter, then lowercase letters, digits and `-`. */
export const match = (segment: string) => NAME.test(segment);
