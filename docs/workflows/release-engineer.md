# Release Engineer workflow

- `check`: deterministic validation only; no model required.
- `prepare`: validate and optionally run bounded repair.
- `package`: require passing checks, create the ZIP, and inspect it.
- `release`: validate/repair, package, checksum, validate again, and write factual notes.

Archives contain sorted normalized regular-file entries with fixed timestamps and modes. Inspection rejects traversal, duplicate names, forbidden entries, symlinks, and manifest/hash mismatch. Dry-run validates a planned manifest but emits no archive or checksum.
