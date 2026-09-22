<script lang="ts">
 import { Button } from '@epicenter/ui/button';
 import { onDestroy } from 'svelte';
 import { ownsRemoteAudio } from '$lib/whispering/recordings.js';
 import { uploadRecording } from '$lib/operations/upload-recording';
 import { report } from '$lib/report';
 import type { Recording } from '../../../../../lib/data.js';
 import { getWhisperingApp } from '$lib/whispering/context';
 let { recording }: { recording: Recording } = $props();
 const app = getWhisperingApp();
 let pending = $state.raw<AbortController | null>(null);
 onDestroy(() => pending?.abort());
 async function upload() {
  if (pending) return;
  const controller = new AbortController();
  pending = controller;
  const result = await uploadRecording(app, recording, controller.signal);
  pending = null;
  if (result.error && !controller.signal.aborted) {
   report.error({ title: 'Could not upload recording', cause: result.error });
  }
 }
</script>

{#if app.remoteBlobs}
 {#if pending}
  <Button variant="outline" size="sm" onclick={() => pending?.abort()}>Cancel upload</Button>
 {:else if recording.remoteAudio && ownsRemoteAudio(app, recording.remoteAudio)}
  <span class="text-sm text-muted-foreground">Audio uploaded</span>
 {:else}
  <Button variant="outline" size="sm" onclick={upload}>Upload audio</Button>
 {/if}
{/if}
