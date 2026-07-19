# Windows IT Evidence Triage

## Trigger

Use to diagnose Windows business IT issues involving AD, Entra ID, Exchange, server access, device enrollment, DNS, Group Policy, workstations, permissions, or networking. It is suitable for NICELAWNS and other environments. Do not use as a generic repair-command playbook.

## Inputs and constraints

Identify affected user, device, domain/tenant, service, exact symptom, time window, recent changes, and available privilege level. Collect read-only evidence first. Use commands appropriate to the current console/context and state their exact working directory when relevant. Never expose credentials or run disruptive changes without explicit confirmation and rollback consideration.

## Workflow

1. Separate candidate layers: local account, domain account/AD, Entra, Exchange, DNS/network, Group Policy, permissions/server access, and endpoint management. Explain what each targeted check proves and what it cannot prove.
2. Collect focused evidence: account/device state, event logs, name resolution/connectivity, policy result, service/authentication outcomes, and relevant management records. Prefer one hypothesis-driven check over broad repair/reset commands.
3. Correlate time, scope, and privilege evidence. Mark probable cause only when it explains the symptom better than alternatives; otherwise retain ranked hypotheses.
4. Before any change, state impact, required privilege, rollback, and verification. Validate the actual user/service flow after an approved remediation and record residual risk.

## Output

Return evidence summary, checks and what they prove, probable cause/ranked alternatives, recommended remediation, explicit disruption warning if applicable, rollback consideration, verification steps, and confirmed versus inferred conclusions.
