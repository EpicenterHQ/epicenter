/** The apps installed in this browser, and the lens every repository opens with: theirs together. */
import { FIRST_PARTY } from './catalog.js';
import { lensOf } from './lens.js';

/** The lens every repository opens with: every installed app's collections. */
export const installedLens = () => lensOf(FIRST_PARTY.map(({ manifest }) => manifest));
