/** Which word note is open to repair as text. `NoteRepair` owns the text being fixed. */
export function createRepair() {
	let open = $state<string | undefined>();
	return {
		get open() {
			return open;
		},
		start(id: string) {
			open = id;
		},
		close() {
			open = undefined;
		},
	};
}

export type Repair = ReturnType<typeof createRepair>;
