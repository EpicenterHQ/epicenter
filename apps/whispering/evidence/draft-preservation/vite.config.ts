import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const local = (name: string) => fileURLToPath(new URL(name, import.meta.url));
export default defineConfig({
	root: local('.'),
	plugins: [
		{
			name: 'inert-recording-actions',
			enforce: 'pre',
			load(id) {
				if (process.env.VITE_DRAFT_BASELINE !== '1') return;
				const path = relative(local('../../../..'), id);
				if (
					![
						'RecordingDetailModal.svelte',
						'RecordingTranscriptCell.svelte',
					].some((name) => id.endsWith(`/recordings/${name}`))
				)
					return;
				return execFileSync(
					'git',
					['show', `5b4bb69a956c56b95fa5ec2dae64b73c5cb4fdbd:${path}`],
					{ cwd: local('../../../..'), encoding: 'utf8' },
				);
			},
			transform(code, id) {
				if (
					!id.endsWith('RecordingDetailForm.svelte') &&
					!id.endsWith('RecordingDetailModal.svelte') &&
					!id.endsWith('RecordingTranscriptCell.svelte')
				)
					return;
				return code
					.replace(
						/from ['"](?:\$lib\/components\/AudioBlobPlayer\.svelte|\.\/actions\/(?:DownloadRecordingButton|TranscribeRecordingButton)\.svelte|\.\/RecordingStorage(?:Action|Badge)\.svelte)['"]/g,
						`from '${local('Empty.svelte')}'`,
					)
					.replace(
						/from ['"]\$lib\/(?:report|utils\/createCopyFn|operations\/delete-recordings)['"]/g,
						`from '${local('stubs.ts')}'`,
					);
			},
		},
		svelte({ configFile: false }),
		tailwindcss(),
	],
	resolve: { alias: { $lib: local('../../src/lib') }, dedupe: ['svelte'] },
	server: {
		port: 5189,
		strictPort: true,
		fs: { allow: [local('../../../..')] },
	},
});
