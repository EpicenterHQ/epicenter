<!--
	The authorization server's login page (ADR-0549). It resumes the OAuth
	authorization that sent the browser here, or returns to the device approval
	or account page that asked for sign-in.
-->
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
 import { readOAuthRequest } from '$lib/auth/oauth-request';
 import { readReturnPath } from '$lib/auth/return-path';

 // Cookie identity belongs to this ceremony, never the dashboard's account cache.
 const queries = new QueryClient();
 $effect(() => () => queries.clear());
 // An authorization request the server signed, or this origin's own page.
 const oauth = readOAuthRequest(window.location.search);
 const resumeUrl = oauth?.resumeUrl ?? readReturnPath(window.location.search, window.location.origin);
 // An account page asked for a different or fresher sign-in, so continuing
 // with the current one would only send the browser back.
 const reauthenticate = !oauth && new URLSearchParams(window.location.search).get('reauth') === '1';
 const session = createQuery(() => ({
  queryKey: ['hosted-login'],
  queryFn: async () => {
   const { data: session, error } = await authClient.getSession({query:{disableCookieCache:true}});
   if(error) throw new Error(error.message ?? 'Could not read browser sign-in.');
   return session;
  },
  retry: false,
 }), () => queries);

 const continueSignIn = createMutation(() => ({
  mutationFn: async () => window.location.replace(resumeUrl),
 }), () => queries);

 const socialSignIn = createMutation(() => ({
  mutationFn: async (provider: SocialProvider) => {
   const callback = new URL(window.location.href);
   callback.searchParams.delete('reauth');
   // A completed provider sign-in creates a new session even with silent SSO.
   const { error } = await authClient.signIn.social({provider,callbackURL:callback.href});
   if(error) throw new Error(error.message ?? 'Could not start sign-in.');
  },
 }), () => queries);

 const passkeySignIn = createMutation(() => ({
  mutationFn: async () => {
   const { error } = await authClient.signIn.passkey();
   if(isPasskeyCancellation(error)) return;
   if(error) throw new Error(error.message ?? 'Passkey sign-in failed.');
   const callback = new URL(window.location.href);
   callback.searchParams.delete('reauth');
   window.location.replace(callback.href);
  },
 }), () => queries);

 const signOut = createMutation(() => ({
  mutationFn: async () => {
   const { error } = await authClient.signOut();
   if(error) throw new Error(error.message ?? 'Could not sign out.');
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
   <h1 class="text-xl font-semibold tracking-tight">{reauthenticate ? 'Sign in again' : 'Sign in to Epicenter'}</h1>
  </Card.Title>
  <Card.Description>
   {reauthenticate ? 'Choose the account to continue with.' : 'Sign in to continue.'}
  </Card.Description>
 </Card.Header>
 <Card.Content class="flex flex-col gap-3">
  {#if session.isPending}
   <Spinner class="mx-auto size-5" />
  {:else}
   {#if session.data?.user}
    <UserIdentity user={session.data.user} orientation="stack" />
    {#if !reauthenticate}
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
