/** This `epicenter`'s version, as its `package.json` states it. */
import packageJson from '../package.json' with { type: 'json' };

export const VERSION = packageJson.version;
