<!-- Runs `make` during component setup, as a component's own script would, and hands its result out. -->
<script lang="ts">
	let { make, expose }: { make: () => unknown; expose: (made: unknown) => void } =
		$props();
	// svelte-ignore state_referenced_locally
	expose(make());
</script>
