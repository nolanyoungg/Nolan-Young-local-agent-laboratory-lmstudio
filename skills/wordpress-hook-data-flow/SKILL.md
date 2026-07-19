# WordPress Hook Data Flow

## Trigger

Use to debug or understand WordPress or WooCommerce behavior distributed across PHP hooks, templates, JavaScript, AJAX/REST, browser events, or plugin integrations (for example ACF, Gravity Forms, checkout, consent, or analytics). Do not use for a one-file syntax review or a release package check.

## Inputs and constraints

Start with the observed behavior, exact URL/context, affected user state, expected result, and repository or site path. Preserve unrelated changes. Inspect read-only before proposing edits; do not assume a plugin is installed, a hook fires, or a browser request succeeds without evidence.

## Workflow

1. State the observable symptom and reproduce path. Find entry points: template/page/block, shortcode, admin action, cron, request route, enqueue, and plugin bootstrap.
2. Search and map actions/filters, callbacks, functions/classes, template inclusion, enqueued assets, AJAX actions and REST routes, browser listeners, and third-party boundaries. For each edge record path, symbol/hook, direction, and evidence.
3. Trace data input, sanitization/transformation, storage (options/meta/session/cart/database), retrieval, and rendered/network output. Separate confirmed calls and requests from inference caused by conventions or unavailable code.
4. Produce a compact map such as `input -> hook/callback -> transform/store -> template/API -> JS event -> visible result`. Identify every likely responsible file and hook, plus the smallest safe change location. Avoid edits until the mapped consumer and producer agree.
5. Give a verification plan covering relevant roles, cache state, request payloads, browser console/network, and plugin configuration. Mark runtime-only checks as unverified when no runnable environment exists.

## Output

Return observed behavior, evidence table, data-flow map, third-party boundaries, likely responsible files/hooks ranked by evidence, smallest safe change location, proposed verification, and confirmed-vs-inferred conclusions. Never present a static search result as proof of runtime behavior.
