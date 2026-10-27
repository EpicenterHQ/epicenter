import { base, build, files, version } from '$service-worker';
import { cacheSite } from '@epicenter/vite-config/offline';

cacheSite(self, { base, build, files, version });
