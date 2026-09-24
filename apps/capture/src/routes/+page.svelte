<script lang="ts">
  import { AppBoot, SignInScreen } from '@epicenter/app-shell/boot-screens';
  import { auth } from '#platform/auth';
  import { openCapture } from '$lib/open.js';
  import CaptureView from '$lib/CaptureView.svelte';
  import { resolve } from '$app/paths';

  const params = new URLSearchParams(location.search);
  const connecting = !params.has('stopped') && (!auth.getState().account || params.has('connect'));
  const account = auth.getState().account;
  const open = !connecting && account && !params.has('stopped')
    ? (signal: AbortSignal) => openCapture(account, signal)
    : undefined;
</script>

{#if connecting}
  <SignInScreen {auth} appName="Capture" noun="captures" />
{:else}
  <AppBoot {auth} {open} appName="Capture" noun="captures"
    signInHref="{resolve('/')}?connect" signedOutHref={resolve('/')}>
    {#snippet children(store)}
      <CaptureView {store} account={account!} />
    {/snippet}
  </AppBoot>
{/if}
