import { APPS } from '@epicenter/constants/apps';
import { installedAppViteConfig } from '@epicenter/vite-config';
import { defineConfig } from 'vite';

export default defineConfig(installedAppViteConfig(APPS.HONEYCRISP));
