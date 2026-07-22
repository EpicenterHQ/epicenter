/**
 * Complete split replica conformance tests.
 *
 * Binds the evidence candidate to the unchanged scalar and document suites so
 * its behavior and crash atomicity are compared against the production store.
 */
import { runDocumentConformanceCases } from './document-cases.test-support.js';
import { runReplicaConformanceCases } from './replica-cases.test-support.js';
import {
	bunSplitDocumentBinding,
	bunSplitReplicaBinding,
} from './bun-split-replica.test-support.js';

runReplicaConformanceCases(bunSplitReplicaBinding);
runDocumentConformanceCases(bunSplitDocumentBinding);
