---
name: github-issue-publishing
description: Convert completed github-repo-review result artifacts into deduplicated GitHub Issues. Use with github-issue-agent to preview or publish a validated repository-review backlog through the GitHub Issues API.
---

# GitHub Issue Publishing

Use only with `github-issue-agent`. Accept a completed `github-repo-review` JSON artifact, retain every supported finding severity, and render deterministic issue text from its path, evidence, impact, recommendation, confidence, limitations, and fingerprint.

Default to dry-run. In publish mode, use `GH_TOKEN` only from the process environment, create `automated-review` and severity labels when missing, search open automated-review issues for an exact fingerprint marker, and create only missing issues. Never modify existing issues.