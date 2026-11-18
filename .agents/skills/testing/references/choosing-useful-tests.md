# Examples of choosing useful tests

These examples are illustrative.

## A passing helper test misses a broken interaction

A component owns an unfinished draft. Its `editDraft` helper forwards
text into a supplied setter. The unit test supplies its own state holder
and checks that the holder received the text.

That test passes even when the component submits an old value. It never
exercises the connection between typing and submission.

Moving the assignment into the component removes the helper and its
callbacks. A component test types into the input, submits it, and checks
the submitted value. Breaking that connection now makes the test fail.

The smaller arrangement catches a mistake the old test could miss.

## Several success checks become one useful scenario

Three tests save the same valid record through the same storage path.
One checks that saving does not throw. Another checks that the result
reports success. The third reads the record and checks its stored value.

One scenario can save the record, assert success, read it through the
actual store, and compare the stored value with the expected value.
It detects both a reported failure and a successful response that lost
the data.

The repeated setup disappears. Separate scenarios for invalid input and
concurrent edits remain because they exercise different failures.

## A controlled transport exposes retry mistakes

A save operation retries a temporary network failure once. Production
supplies the real transport; tests supply controlled responses.

One test makes the first request fail temporarily and the second succeed.
It checks that the operation retries once and returns the successful
result. Another makes both requests fail and checks that the operation
stops after the retry.

The tests can detect a missing retry, an endless retry, or an incorrectly
reported success. The controlled transport makes those failures
reproducible without depending on a real server failing at the right
moment.

The boundary earns its place even though production always supplies the
same transport.

## A cancellation test never reaches pending work

A test named "cancelling a save preserves newer work" supplies a save that
completes immediately. It calls cancel afterward and checks that the current
text is unchanged. A broken cancellation path can pass because no response
arrives after cancellation.

A replacement holds the save pending, cancels it, and then delivers its late
response. It checks that the newer work survives. Removing the guard against
late updates makes that assertion fail, showing that the test exercises the
race its name describes.

The replacement preserves the cancellation scenario with setup that can expose
its failure. Passing the original test established no such protection.
