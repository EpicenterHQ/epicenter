const confirmation = Promise.withResolvers<void>();
const commit = Promise.withResolvers<void>();
const producer = Promise.withResolvers<void>();
const opening = Promise.withResolvers<void>();

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
	holdConfirmation: false,
	confirmation: confirmation.promise,
	releaseCommit: commit.resolve,
	releaseProducer: producer.resolve,
	releaseOpening: opening.resolve,
	opening: opening.promise,
	commit: commit.promise,
	producer: producer.promise,
};

Reflect.set(window, 'bootProbe', probe);
