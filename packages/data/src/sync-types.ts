export type SyncCredentialProvider = {
	get(): string | undefined;
	subscribe?(listener: () => void): () => void;
};

export type SyncSchedule = (task: () => void, delayMs: number) => () => void;
