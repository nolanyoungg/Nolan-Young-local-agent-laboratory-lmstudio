# Windows-to-Mac Topology

The Windows process always calls its own LM Studio server:

```text
Windows TypeScript application
  -> http/ws://127.0.0.1:1234
  -> LM Studio on Windows
  -> LM Link
  -> preferred Mac LM Studio or llmster
  -> GPT-OSS inference
```

LM Link presents linked models through the local Windows API. When the same model exists on both machines, the Windows LM Link preferred-device choice determines load routing. The application deliberately does not choose a device.

Filesystem reads, writes, patches, builds, tests, checks, ZIP creation, hashes, logs, and reports all remain on Windows. Only selected prompt and tool-result text crosses LM Link.

Do not configure a Mac IP, expose either API server to the LAN, mount the Mac filesystem, or invoke the model over SSH.
