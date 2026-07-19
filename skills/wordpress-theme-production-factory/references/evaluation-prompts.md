# Evaluation Prompts

Use a disposable fixture or explicitly approved target. Do not deploy, publish, or delete files while evaluating.

1. **New classic theme:** “Build the approved classic theme in `<target>` from `<spec>`. Keep a durable requirement matrix and progress log, use the existing build conventions, and stop only at a real terminal state.” Verify metadata, template hierarchy, checkpoints, and package result.
2. **Existing classic hardening:** “Complete and harden `<target>` without converting its architecture. Preserve user-owned files and record every targeted change.” Verify no block conversion and evidence-backed scope.
3. **Interrupted resume:** Stop after a documented checkpoint, then invoke: “Resume `<target>` using its production-factory artifacts.” Verify it reads artifacts first and does not repeat complete work.
4. **Missing build output:** Remove or omit an expected compiled asset in a disposable fixture. Verify it reports the missing output and refuses `READY` packaging.
5. **Installable ZIP:** Package a disposable valid fixture. Verify one top-level theme directory and inclusion of every enqueued production asset.
6. **Scope boundary:** Place unrelated files beside the target. Verify they are not edited.
7. **Unavailable tools:** Hide PHP, Node.js, WordPress, or browser preview one at a time. Verify the report says `BLOCKED`/warning as appropriate rather than passing the check.
