<!-- Hosted cookie login authorizes one exact, PKCE-bound client handoff. -->
<script lang="ts">
 import * as Alert from '@epicenter/ui/alert';
 import { Button } from '@epicenter/ui/button';
 import * as Card from '@epicenter/ui/card';
 import { Spinner } from '@epicenter/ui/spinner';
 import FingerprintIcon from '@lucide/svelte/icons/fingerprint';
 import { createMutation, createQuery, QueryClient } from '@tanstack/svelte-query';
 import EpicenterMark from '$lib/auth/EpicenterMark.svelte';
 import ProviderButton from '$lib/auth/ProviderButton.svelte';
 import UserIdentity from '$lib/auth/UserIdentity.svelte';
 import { authClient, isPasskeyCancellation, supportsPasskeys } from '$lib/auth/client';
 import { SOCIAL_PROVIDERS, type SocialProvider } from '$lib/auth/providers';
 import { readSessionRequest } from '$lib/auth/session-request';

 // Cookie identity belongs to this ceremony, never the dashboard's account cache.
 const queries = new QueryClient();
 $effect(() => () => queries.clear());
 const request = readSessionRequest(window.location.search);
 const session = createQuery(() => ({
  queryKey: ['hosted-login'],
  queryFn: async () => {
   const result = await authClient.getSession({query:{disableCookieCache:true}});
   if(result.error) throw new Error(result.error.message ?? 'Could not read browser sign-in.');
   return result.data;
  },
  retry: false,
 }), () => queries);

 const continueSignIn = createMutation(() => ({
  mutationFn: async () => {
   if(!request) throw new Error('Start sign-in from the app you want to use.');
   const response = await fetch('/auth/session/authorize',{
    method:'POST', credentials:'include', redirect:'error',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({callback:request.callback,challenge:request.challenge,state:request.state}),
   });
   const result = await response.json() as {url?:string;message?:string};
   if(!response.ok || !result.url) throw new Error(result.message ?? 'Could not complete sign-in.');
   // The server approves the callback; verify its binding again before navigation.
   const destination = new URL(result.url);
   const code = destination.searchParams.get('code');
   const state = destination.searchParams.get('state');
   destination.search = '';
   if(destination.href !== request.callback || !code || state !== request.state)
    throw new Error('Invalid sign-in destination.');
   window.location.replace(result.url);
  },
 }), () => queries);

 const socialSignIn = createMutation(() => ({
  mutationFn: async (provider: SocialProvider) => {
   const callback = new URL(window.location.href);
   callback.searchParams.delete('reauth');
   // A completed provider sign-in creates a new session even with silent SSO.
   const result = await authClient.signIn.social({provider,callbackURL:callback.href});
   if(result.error) throw new Error(result.error.message ?? 'Could not start sign-in.');
  },
 }), () => queries);

 const passkeySignIn = createMutation(() => ({
  mutationFn: async () => {
   const result = await authClient.signIn.passkey();
   if(isPasskeyCancellation(result.error)) return;
   if(result.error) throw new Error(result.error.message ?? 'Passkey sign-in failed.');
   const callback = new URL(window.location.href);
   callback.searchParams.delete('reauth');
   window.location.replace(callback.href);
  },
 }), () => queries);

 const signOut = createMutation(() => ({
  mutationFn: async () => {
   const result = await authClient.signOut();
   if(result.error) throw new Error(result.error.message ?? 'Could not sign out.');
   await queries.invalidateQueries({queryKey:['hosted-login']});
  },
 }), () => queries);
 const busy = $derived(continueSignIn.isPending || socialSignIn.isPending || passkeySignIn.isPending || signOut.isPending);
 const error = $derived(continueSignIn.error ?? socialSignIn.error ?? passkeySignIn.error ?? signOut.error ?? session.error);
</script>

<svelte:head>
 <title>Sign in: Epicenter</title>
 <meta name="referrer" content="no-referrer" />
</svelte:head>

<div class="flex min-h-dvh items-center justify-center p-6">
 <Card.Root class="w-full max-w-sm gap-5">
  <div class="flex justify-center">
   <EpicenterMark class="size-12 rounded-xl" />
  </div>
 <Card.Header class="justify-items-center text-center">
  <Card.Title>
   <h1 class="text-xl font-semibold tracking-tight">{request?.reauthenticate ? 'Sign in again' : 'Sign in to Epicenter'}</h1>
  </Card.Title>
  <Card.Description>
   {#if request}Continue to {new URL(request.callback).host}.{:else}Start sign-in from the app you want to use.{/if}
  </Card.Description>
 </Card.Header>
 <Card.Content class="flex flex-col gap-3">
  {#if session.isPending}
   <Spinner class="mx-auto size-5" />
  {:else}
   {#if session.data?.user}
    <UserIdentity user={session.data.user} orientation="stack" />
    {#if request && !request.reauthenticate}
     <Button disabled={busy} onclick={() => continueSignIn.mutate()}>
      {#if continueSignIn.isPending}<Spinner class="size-4" />{/if}
      Continue as {session.data.user.email}
     </Button>
    {/if}
    <Button variant="outline" disabled={busy} onclick={() => signOut.mutate()}>Sign out of this browser</Button>
   {/if}
   {#each SOCIAL_PROVIDERS as provider (provider)}
    <ProviderButton {provider} disabled={busy} onclick={() => socialSignIn.mutate(provider)} />
   {/each}
   {#if supportsPasskeys()}
    <Button variant="outline" disabled={busy} onclick={() => passkeySignIn.mutate()}>
     <FingerprintIcon class="size-4" /> Continue with passkey
    </Button>
   {/if}
  {/if}
  {#if error}<Alert.Root variant="destructive"><Alert.Description>{error.message}</Alert.Description></Alert.Root>{/if}
 </Card.Content>
 </Card.Root>
</div>
