# Controller and Linked-Device Topology

The controller-machine process always calls its own local LM Studio server:

```text
Controller TypeScript application
  -> http/ws://127.0.0.1:1234
  -> local LM Studio server on the controller machine
  -> LM Link
  -> preferred linked device running LM Studio or llmster
  -> model inference
```

LM Link presents linked models through the controller machine's local API.
When the same logical model exists on more than one device, set the desired
inference device as preferred in LM Studio. The application deliberately does
not choose a device.

Filesystem reads, writes, patches, builds, tests, checks, ZIP creation, hashes,
logs, and reports all remain on the controller machine. Only selected prompt
and tool-result text crosses LM Link.

Do not configure a linked-device IP, expose either API server to the LAN, mount
a linked-device filesystem, or invoke the model over SSH.
