/** Acceptance-only access to the mounted App opener and captured Account. */
export function observeBoot() {
	return {
		name: 'observe-mounted-app-boot',
		enforce: 'pre',
		transform(code, id) {
			if (!id.endsWith('/boot-screens/app-boot.svelte')) return;
			return code.replace(
				'</script>',
				'Reflect.set(globalThis, "observedBoot", { opening, account });\n</script>',
			);
		},
	};
}
