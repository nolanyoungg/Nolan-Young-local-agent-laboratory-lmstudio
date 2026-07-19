# Tracking Consent Audit

## Trigger

Use to audit or improve technical tracking, attribution, consent gating, cookies/storage, or duplicate events across GTM, GA4, Ads, Meta, CallRail, Klaviyo, session replay, UTMs, and similar tools. Start with read-only evidence collection. This is technical implementation guidance, not legal advice; legal interpretation requires qualified counsel.

## Workflow

1. Identify pages, environments, banner/CMP configuration, consent categories, regions, and each configured tracker. Inspect source, tag manager configuration, browser requests, cookies/local/session storage, data layer, and vendor settings without exposing IDs or secrets unnecessarily.
2. Build an inventory: tracker, configuration location, trigger, data/identifiers received, pre/post-consent load state, controlling category, potential duplicate path, and test evidence. Include GTM/GA4/Ads/Meta/CallRail/Klaviyo, replay tools, and UTM capture where present.
3. Test clean browser states before consent, after accepting each category, after rejecting, after revoking, and with Global Privacy Control where supported. Use browser developer tools and GTM Preview to verify script execution, network requests, cookies, data-layer events, and Consent Mode behavior.
4. Trace duplicate events from page code, GTM tags, plugins, server-side tools, and enhanced/conversion integrations. Call a duplicate confirmed only when the same event is evidenced more than once for one action.
5. Specify precise technical remediation: trigger/consent-state changes, data-layer normalization, removal of one duplicate producer, or storage cleanup. Re-test pre- and post-consent behavior; do not claim compliance from a technical audit.

## Output

Return tracker inventory, consent-gating matrix, pre/post-consent test plan, confirmed duplicate events, remediation steps, evidence/inference boundary, blocked checks, and the counsel-review notice.
