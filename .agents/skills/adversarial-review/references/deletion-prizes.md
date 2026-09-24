# Deletion prizes from simpler operating rules

These examples capture review moves supplied by the user. They are design
proposals to examine against current code and requirements, not statements of
Epicenter's implemented behavior or blanket authorization to change it.

## End the page lifetime when the account changes

A person switches accounts. Instead of keeping the page alive while every
store, subscription, request, and cache changes identity, the application does
a full page reload and constructs the next page for the new account.

The proposed invariant is that one page lifetime belongs to one account.
The reviewer investigates whether this removes account-change listeners,
rebinding, teardown ordering, and intermediate states across consumers. The
prize is the disappearance of that transition model, not a shorter listener.

The person pays for a reload and may lose transient page state. Verify that
account changes actually end the old lifetime and that persistent state and
in-flight work respect the account boundary; a reload alone does not establish
those guarantees. The review must show which coordination becomes unnecessary
and which boundary checks still earn their place.

## Let the person own a complete data reset

A person wants to remove all their synced data. One possible product contract
requires them to account for every device, clear each local cache, then clear
the remote cache. The software does not promise to coordinate a global reset
across devices on their behalf.

The reviewer investigates whether accepting that procedure removes device
acknowledgments, deletion propagation, reset orchestration, or other machinery
whose sole purpose is the stronger promise. Those are candidate deletions to
verify in the actual design, not a prescribed list of files to remove.

The burden is real: the person must remember and access every device and prevent
remaining replicas from uploading old data during the procedure. A missed or
offline device can retain data and may restore it later. The application cannot
claim that clearing the remote cache alone deletes every copy. Any other
retained copies must be accounted for before claiming complete deletion.

This is a user obligation, not a software-enforced invariant. The reviewer
should still propose the bargain when it deletes disproportionate complexity,
and state the obligation precisely enough for the human to judge it.

## Carry the question beyond these examples

Ask which ongoing coordination problem disappears if a lifetime ends earlier,
a promise narrows, or a person takes responsibility for an explicit operation.
Show the simpler system, the code and future work it removes, and the cost of
the new rule. Do not cargo-cult reloads or manual deletion into unrelated work.
