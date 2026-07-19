# WordPress Search Indexing Contract

## Trigger

Use to trace WordPress/WooCommerce content into an Algolia-style index or product grid and verify the indexed schema matches customer-visible data. Do not use to apply an unverified price workaround or for generic search relevance tuning.

## Inputs and constraints

Require the exact source/theme/plugin paths, index or import path when available, sample product IDs, visible discrepancy, and reindex context. Preserve unrelated changes and start with read-only evidence before edits. Treat index-access, cache, and browser results as runtime evidence only when directly observed.

## Workflow

1. Map product/variation IDs and parent/variation relationships from WooCommerce through indexing hooks, import transformations, index schema, cache/reindex behavior, theme overrides, and front-end rendering.
2. Build a field-contract table: WooCommerce source field, transformation location, indexed field, front-end consumer, expected value, actual value, and test case. Include title, image, URL, categories, attributes, stock, regular/sale/active/formatted prices.
3. Inspect actual records and consumer code before proposing changes. Distinguish stale/cached records, mapping defects, parent-versus-variation selection, formatting-only defects, and unavailable index evidence. Never introduce speculative price hacks.
4. Test simple products, variable parents, every relevant variation, sale products, out-of-stock products, and reindex behavior; verify the grid/search UI after cache invalidation under an approved safe process.

## Output

Return the field contract, source-to-index-to-UI map, responsible hooks/files, stale-data analysis, minimal safe change, reindex/test plan, and confirmed versus inferred results.
