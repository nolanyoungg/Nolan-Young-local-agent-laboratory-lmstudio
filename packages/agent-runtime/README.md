# @local-agent-lab/agent-runtime

A provider-neutral, one-action-per-turn agent loop with Zod validation, permission enforcement, step/context limits, bounded model retries, and in-run mutation deduplication.

Model retries never execute tools. Tool calls are journaled by both call ID and canonical operation fingerprint so a completed mutation cannot be replayed after a reconnect.
