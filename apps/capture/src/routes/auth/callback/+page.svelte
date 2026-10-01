<script lang="ts">
  import { isCallbackAuthClient } from '@epicenter/auth';
  import { Loading } from '@epicenter/ui/loading';
  import { auth } from '#platform/auth';
  let errorMessage = $state<string | null>(null);
  $effect(() => {
    void (async () => {
      if (!isCallbackAuthClient(auth)) {
        errorMessage = 'This build does not use browser sign-in.';
        return;
      }
      const { error } = await auth.completeSignIn();
      if (error) { errorMessage = error.message; return; }
      window.location.replace('/');
    })();
  });
</script>

{#if errorMessage}<p role="alert">{errorMessage}</p>{:else}<Loading class="h-dvh" label="Signing in…" />{/if}
