import type { Os } from './types.js';

const platform = typeof navigator === 'undefined' ? '' : navigator.platform;
export const os: Os = {
 isApple: /Mac|iPhone|iPad|iPod/.test(platform),
 isLinux: /Linux/.test(platform),
};
