import { cacheSite } from '@epicenter/vite-config/offline';
import { base, build, files, version } from '$service-worker';

cacheSite(self, { base, build, files, version });
