<!-- An app root for the adapter's test: shows its path and the repository's status, and moves through `navigate`. -->
<script lang="ts">
	import type { AppManifest } from '@epicenter/app';
	import type { AppProps } from '../app/mount.svelte.js';

	let { repo, path, navigate }: AppProps<AppManifest> = $props();
</script>

<p data-testid="path">{path}</p>
<p data-testid="status">{repo.status().status}</p>
<button type="button" onclick={() => void navigate('/next', { replace: true })}>Next</button>
