import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, searchForWorkspaceRoot, type UserConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit(), tailwindcss()] as UserConfig['plugins'],
	server: {
		port: 5191,
		strictPort: true,
		fs: { allow: [searchForWorkspaceRoot(process.cwd())] },
		proxy: { '/api': 'http://127.0.0.1:5190' },
	},
});
