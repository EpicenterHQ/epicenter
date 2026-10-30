import { APPS } from '@epicenter/constants/apps';
import { hostAppViteConfig } from '@epicenter/vite-config';
import { defineConfig } from 'vite';

export default defineConfig(hostAppViteConfig(APPS.CAPTURE));
