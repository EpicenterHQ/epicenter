const commit = Promise.withResolvers<void>();
const producer = Promise.withResolvers<void>();
const opening = Promise.withResolvers<void>();
const signOut = Promise.withResolvers<void>();
const signIn = Promise.withResolvers<void>();

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
	releaseCommit: commit.resolve,
	releaseProducer: producer.resolve,
	releaseOpening: opening.resolve,
	releaseSignOut: signOut.resolve,
	releaseSignIn: signIn.resolve,
	opening: opening.promise,
	commit: commit.promise,
	producer: producer.promise,
	signOut: signOut.promise,
	signIn: signIn.promise,
};
window.addEventListener('pageshow', (event) =>
	probe.events.push(`pageshow:${event.persisted}`),
);
Reflect.set(window, 'bootProbe', probe);
