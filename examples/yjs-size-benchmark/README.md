# Y.Doc size benchmark

An interactive raw-CRDT benchmark using the repository’s pinned
`@y/y@14.0.0-rc.26`. Each table is a root node and each row is a nested node
whose attributes hold generated JSON fields. This measures metadata storage,
not the full Epicenter row/body contract.

Run `bun run --cwd examples/yjs-size-benchmark dev` from the repository root.
The page measures encoded size, insertion speed, encoding/decoding time, and
browser heap usage where available. Downloaded `.yjs` files contain the
benchmark document. Old Yjs 13 measurements do not describe this version;
run the presets to obtain current measurements.
