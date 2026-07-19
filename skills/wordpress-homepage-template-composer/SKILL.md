# WordPress Homepage Template Composer

## Trigger and boundary

Use to compose one polished, original, responsive homepage for a classic WordPress theme: `home-page.php`, exactly nine required content template parts, and only the necessary scoped styles/approved JavaScript. Use when the task is a coherent conversion-oriented homepage, not a generic section, a block-theme build, or a site-wide redesign. Use `wordpress-theme-production-factory` for a broad theme implementation and `wordpress-asset-build-integrity` for build-only diagnosis.

## Discovery and scope

Require the exact approved theme root and homepage scope. Start read-only. Determine classic/block/child/hybrid architecture; template-part paths/names; CSS/SCSS/Sass/build/JS conventions; typography, colors, spacing, breakpoints, buttons, containers, cards, and utilities; existing dynamic-data systems; existing `home-page.php`; and whether `front-page.php`, `home.php`, page assignment, or another template controls the homepage.

Preserve user-owned files and existing architecture. Never overwrite a homepage/template part without first inspecting it, recording its current behavior, and making a targeted approved change. Do not assume `home-page.php` is automatically selected: add a correct page-template header if it is editor-selectable, or explain the safe integration with existing hierarchy/assignment. Never edit unrelated templates, plugins, global architecture, or files outside the approved homepage scope.

## Fixed composition contract

Create `home-page.php` and exactly these content template-part filenames in the target theme’s established template-part directory:

1. `content-home-hero.php`
2. `content-home-trust.php`
3. `content-home-introduction.php`
4. `content-home-services.php`
5. `content-home-feature.php`
6. `content-home-process.php`
7. `content-home-results.php`
8. `content-home-testimonials.php`
9. `content-home-cta.php`

Load them with WordPress-safe template-part functions in this exact conversion order: hero, trust, introduction, services, feature, process, results, testimonials, CTA. Use the theme’s header/footer conventions, semantic main content, a stable homepage wrapper, needed loop behavior, and no duplicate global layout. Use helpers rather than hardcoded URLs, paths, names, or theme directories. See [section contract](references/section-contract.md) for responsibility and fallback rules.

## Implementation rules

Give every part one responsibility, semantic accessible HTML, correct homepage heading hierarchy, scoped maintainable classes, and safe fallback markup. Use existing design tokens/components first; scope new styles to the homepage wrapper and extend the existing style/build architecture rather than creating a parallel one. Design desktop, tablet, and mobile deliberately; include touch targets, focus states, contrast, readable line length, responsive spacing, no horizontal overflow, and reduced-motion support for any approved motion.

Use existing ACF/customizer/menu/query/WooCommerce patterns only when present. Never add ACF, libraries, builders, icon frameworks, sliders, CSS frameworks, or plugin responsibilities without approval. Optional plugin calls must be guarded so absence cannot fatal. Escape output. Do not use fake claims, reviews, logos, statistics, clients, awards, copied layouts/content/assets, or invented marketing copy; use supplied assets/data or clearly marked honest placeholders. Carousels are optional and must be progressively enhanced, keyboard accessible, pauseable, and readable without JavaScript.

## Validation and final report

From the exact working directory, confirm `home-page.php` loads all nine required parts and every referenced part/asset exists. Run `php -l` on all changed PHP, existing build/lint/typecheck/test/package commands, and the build when present. When a safe local WordPress preview exists, check desktop/tablet/mobile, console/network, keyboard/focus, headings, and basic screen-reader semantics. Report missing PHP/Node/WordPress/browser tooling as `BLOCKED`, never passed.

Return: exact homepage and nine part paths; created/changed style, script, and build files; WordPress assignment/loading explanation; section summary; dynamic sources; commands/results; and placeholders, assumptions, warnings, and blocked checks. Status is `READY`, `READY WITH WARNINGS`, `NOT READY`, or `BLOCKED`; never call it production-ready while a material check or requirement is incomplete. Use [evaluation prompts](references/evaluation-prompts.md) for focused fixture tests.
