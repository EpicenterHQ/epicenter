# 0907. Private input is a whole-call handling policy

- **Status:** Accepted (2026-11-14)
- **Date:** 2026-11-14
- **Amends:** [ADR-0906](0906-confidentiality-is-explicit-action-metadata.md), replacing the `confidential` property name. The behavior remains.

## Context

An app may need private input, such as a token that connects it to a service.
Epicenter handles that input without offering the action over MCP or copying
the input into arguments, validation details, or commit names. The app validates
the credential, decides where to store it, and owns its outputs.

Calling the whole action confidential suggests a broader guarantee than this
input policy supplies. In particular, HTTP remains available and results are
not redacted. Private input does not establish who the caller is.

## Decision

Declare `privateInput: true` on the action. The flag applies to its entire input,
including ordinary fields and undeclared property names. Fields describe valid
values independently of this policy.

- HTTP accepts the JSON body under the server's existing access rules.
- The CLI accepts exactly `--input -`, using its ordinary JSON stdin path.
- MCP neither lists nor runs the action, including calls to guessed names.
- Schema validation returns a fixed refusal with no supplied input details.
- Commit subjects contain only the app and action names.

The action runs normally. Apps own what they return, throw, yield, and write.
Local storage follows the existing `.local` rules. Messages checks a token with
Beeper before replacing the saved token, then returns connection status.

## Consequences

There is one policy property and no compatibility alias. `confidential` is an
unknown action key and is refused at declaration, so an old caller fails closed.
Messages and JSON discovery migrate to `privateInput` with the framework.

The implementation keeps direct checks at each relevant boundary. It adds no
credential store, setup registry, or separate action execution path.
