const commit = Promise.withResolvers<void>();
const producer = Promise.withResolvers<void>();

export const probe = {
	events: [] as string[],
	refuse: false,
	releaseCommit: commit.resolve,
	releaseProducer: producer.resolve,
	commit: commit.promise,
	producer: producer.promise,
};

Reflect.set(window, 'bootProbe', probe);
