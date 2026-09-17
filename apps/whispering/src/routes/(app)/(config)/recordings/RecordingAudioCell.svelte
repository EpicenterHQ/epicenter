<script lang="ts">
 import { createQuery } from '@tanstack/svelte-query';
 import type { Recording } from '$lib/state/recordings.svelte';
 import { getWhisperingQueries } from '$lib/whispering/context';
 import RenderAudioUrl from './RenderAudioUrl.svelte';
 let { recording }: { recording: Recording } = $props();
 const queries = getWhisperingQueries();
 const availability = createQuery(() => queries.audio.availability(() => recording).options);
</script>

{#if availability.data === 'local-only' || availability.data === 'remote'}
 <RenderAudioUrl id={recording.id} audio={recording.audioUrl ?? recording.audioBlobId} />
{:else}
 <span class="text-sm text-muted-foreground">Audio unavailable on this device</span>
{/if}
