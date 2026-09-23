<script lang="ts">
  import { AppBoot, SignInScreen } from '@epicenter/app-shell/boot-screens';
  import { auth } from '$lib/auth.js';
  import { openCapture } from '$lib/open.js';
  import CaptureView from '$lib/CaptureView.svelte';

  const params = new URLSearchParams(location.search);
  const connecting = !params.has('stopped') && (!auth.getState().account || params.has('connect'));
  const account = auth.getState().account;
  const open = !connecting && account && !params.has('stopped')
    ? (signal: AbortSignal) => openCapture(account, signal)
    : undefined;
</script>

{#if connecting}
  <SignInScreen {auth} appName="Capture" noun="entries" />
{:else}
  <AppBoot {auth} {open} appName="Capture" noun="entries"
    signInHref="/?connect" signedOutHref="/">
    {#snippet children(store)}
      <CaptureView {store} />
    {/snippet}
  </AppBoot>
{/if}
