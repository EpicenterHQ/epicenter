import { hostAppViteConfig } from '@epicenter/vite-config';
import { defineConfig } from 'vite';
export default defineConfig(hostAppViteConfig({ port: 5188 }));
