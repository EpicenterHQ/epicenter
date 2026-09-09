import {
	captureLibraryReplica,
	type LibraryReplicaIdentity,
} from '@epicenter/principal';

/** Address of local native bytes, never a filesystem path or credential. */
export type BlobDestination = {
	appId: string;
	replica:
		| { library: 'local' }
		| {
				library: 'personal';
				account: { authorityId: string; principalId: string };
		  }
		| {
				library: 'shared';
				account: { authorityId: string; principalId: string };
		  };
};

export function blobDestination(
	appId: string,
	replica: LibraryReplicaIdentity,
): BlobDestination {
	return { appId, replica: captureLibraryReplica(replica) };
}
