<script lang="ts">
 import { createQuery } from '@tanstack/svelte-query';
 import type { Recording } from '../../../../lib/data.js';
 import { getWhisperingQueries } from '$lib/whispering/context';
 import AudioBlobPlayer from '$lib/components/AudioBlobPlayer.svelte';
 import { viewTransition } from '$lib/utils/viewTransitions';
 let { recording }: { recording: Recording } = $props();
 const queries = getWhisperingQueries();
 const availability = createQuery(() => queries.audio.availability(() => recording).options);
</script>

{#if availability.data === 'local' || availability.data === 'remote'}
 <AudioBlobPlayer id={recording.id} class="h-8" viewTransitionName={viewTransition.recording(recording.id).audio} />
{:else}
 <span class="text-sm text-muted-foreground">Audio unavailable on this device</span>
{/if}
