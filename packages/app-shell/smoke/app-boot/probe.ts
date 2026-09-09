const commit = Promise.withResolvers<void>();
const producer = Promise.withResolvers<void>();

export const probe = {
	events: new Proxy(
		JSON.parse(sessionStorage.getItem('events') ?? '[]') as string[],
		{
			set(target, key, value) {
				Reflect.set(target, key, value);
				sessionStorage.setItem('events', JSON.stringify(target));
				return true;
			},
		},
	),
	refuse: false,
	releaseCommit: commit.resolve,
	releaseProducer: producer.resolve,
	commit: commit.promise,
	producer: producer.promise,
};

Reflect.set(window, 'bootProbe', probe);
