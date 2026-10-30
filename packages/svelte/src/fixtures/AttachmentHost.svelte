<script lang="ts">
	import { attachment, type AttachmentSource } from '../repository/attachment.svelte.js';

	let { repo, path }: { repo: AttachmentSource; path: string | null } = $props();
	// svelte-ignore state_referenced_locally
	const shown = attachment(repo, () => path);
</script>

<p data-testid="status">{shown.current.status}</p>
{#if shown.current.status === 'here'}<audio data-testid="audio" src={shown.current.url}></audio>{/if}
{#if shown.current.status === 'unavailable'}<button data-testid="retry" onclick={shown.current.retry}>Retry</button>{/if}
