# WooCommerce Variation Data Flow

## Trigger

Use for variable-product behavior involving selected attributes, pricing, stock, shipping/delivery eligibility, add-to-cart, cart/checkout, order metadata, or customer messages. Do not use for a non-variation WooCommerce issue; use `wordpress-hook-data-flow` for a broader cross-system trace.

## Inputs and constraints

Require the product, relevant variation IDs/attributes, customer destination/session assumptions, affected pages, and current versus desired behavior. Preserve unrelated changes and begin with read-only discovery. Treat selected variation data as authoritative where WooCommerce provides it; never let parent-product assumptions silently override it.

## Workflow

1. Write a before/after behavior table for every relevant variation and customer path (product page, add-to-cart, cart, shipping, checkout, order, confirmation). Include “Local Delivery Only” and “Ships to All Zip Codes” cases when applicable.
2. Trace admin configuration -> parent/variation metadata -> PHP product/cart/shipping hooks -> variation JSON/AJAX response -> browser variation events -> cart calculations/shipping methods -> checkout validation -> order metadata -> customer messages.
3. Name every consumer of the affected field, including redirects and analytics. Preserve enabled add-to-cart redirects; fire success-only events only after WooCommerce confirms a successful add-to-cart response or navigation.
4. Verify whether needed fields are exposed in variation data. Add only minimal, escaped, variation-aware data/filtering and ensure product, cart, and checkout messages use the same source of truth.
5. Test each variation, relevant ZIP/delivery path, logged-in/out state, stock/sale state, add-to-cart outcome, cart update, shipping recalculation, checkout, and order output. Distinguish actual WooCommerce configuration from theme JavaScript display logic.

## Output

Provide the before/after table, source-to-consumer flow, affected hooks/files/events, authoritative-data decision, smallest safe change, explicit test matrix, evidence/inference boundary, and a rollback-safe verification plan.
