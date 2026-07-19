# Pressable Safe Operations

## Trigger

Use for inspection, deployment, recovery, or validation of a Pressable-hosted WordPress site through approved SSH, SFTP, WordPress admin, staging, Git, theme, or plugin paths. Do not use to diagnose application logic without a deployment action.

## Constraints

Treat Pressable as SFTP/SSH-based hosting: never assume ordinary FTP. Require separately labeled exact local, staging, and production paths before any operation. Inspect read-only first; preserve unrelated files; do not run broad delete, recursive replace, database mutation, or restore actions without explicit confirmation and a recovery plan. Never expose credentials.

## Workflow

1. Confirm site/environment, host, account, deployment method, exact target path, active theme/plugin, scope, and rollback owner. Verify paths with read-only listing before transfer.
2. Recommend staging first for meaningful production work. Capture a backup/recovery point and define restore verification before destructive changes. For Git deployments, verify repository layout, ignored files, branch/revision, and deployment root rather than assuming the repository root is web root.
3. Deploy only the agreed files through the approved path (SFTP, SSH, admin upload, or Git). Avoid overwriting generated/user data and never remove a directory merely to make a transfer succeed.
4. Validate the expected theme/plugin is active, relevant pages/forms/WooCommerce flows work, intended assets load, and browser console has no introduced errors. Keep production-only credentials and identifiers out of reports.
5. State rollback: stop further deployment, restore the recorded theme/plugin/files or backup, verify active component and affected flow, then document the outcome.

## Output

Return environment/path confirmation, read-only evidence, change plan, backup/rollback plan, deployment record, post-deploy checks, failures versus warnings, and what remains unverified.
