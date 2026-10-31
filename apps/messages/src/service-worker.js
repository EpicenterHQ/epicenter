/**
 * Caches the built page and its static files, so a page loaded once
 * reopens offline (decision 85). Data never passes through it: the files
 * are in this browser's OPFS, and requests to other origins are left alone.
 */

import { cacheSite } from '@epicenter/vite-config/offline';
import { base, build, files, version } from '$service-worker';

cacheSite(self, { base, build, files, version });
