# Adding an application

This repository intentionally contains exactly three applications. Extending it requires an architectural change: create a private workspace under `apps/`, add its project reference, define laboratory-owned permissions and policy, give it a single report writer, and add CI/help/smoke coverage. Do not make examples npm workspaces.

An application owns workflow semantics and `final-report.md`; shared packages own model, runtime, security, tools, contracts, and tracing behavior.
