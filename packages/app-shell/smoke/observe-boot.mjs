/** Acceptance-only access to the mounted owner; production builds have no hook. */
export function observeBoot() {
	return {
		name: 'observe-mounted-app-boot',
		enforce: 'pre',
		transform(code, id) {
			if (!id.endsWith('/boot-screens/app-boot.svelte')) return;
			return code.replace(
				'</script>',
				`Reflect.set(globalThis, "observedBoot", { opening, lifetime, account });
     $effect(() => { if (lifetime.state.phase === 'closed') sessionStorage.setItem('closed-library', localStorage.getItem('whispering.library') ?? 'personal'); });
     </script>`,
			);
		},
	};
}
