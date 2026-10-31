import { APPS } from '@epicenter/constants/apps';
import { workspaceAppViteConfig } from '@epicenter/vite-config';
import { defineConfig } from 'vite';

export default defineConfig(workspaceAppViteConfig(APPS.HONEYCRISP));
