# Homepage Section Contract

| Part                            | Responsibility                                                                                                  | Safe fallback                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `content-home-hero.php`         | Value proposition, supporting copy, primary action, optional secondary action/visual; works without JavaScript. | Neutral supplied or clearly marked placeholder copy; no mandatory media.     |
| `content-home-trust.php`        | Approved logos, ratings, certifications, partners, service areas, or proof points.                              | Omit cleanly or show neutral structural proof points; never invent proof.    |
| `content-home-introduction.php` | Human brand/mission bridge from promise to services.                                                            | Short editable introduction.                                                 |
| `content-home-services.php`     | Accessible service cards/links; use arbitrary count when existing data supports it.                             | Static editable cards or an empty-safe section.                              |
| `content-home-feature.php`      | Strong split layout for one differentiator, story, product, or service.                                         | Text-first layout; media remains optional.                                   |
| `content-home-process.php`      | Three or more readable steps, independent of color/icon meaning.                                                | Numbered semantic list.                                                      |
| `content-home-results.php`      | Real case studies, work, outcomes, or before/after evidence.                                                    | Honest “proof coming” structure that does not imply results.                 |
| `content-home-testimonials.php` | One or more accessible testimonials/reviews; no-JS readable.                                                    | Omit or editable attribution-free placeholder, never fabricated testimonial. |
| `content-home-cta.php`          | Final next step, reassurance, optional secondary contact.                                                       | Action linked with a safe WordPress helper or editable placeholder.          |

Use heading levels relative to the single homepage `h1`; do not add a section heading merely for visual styling. Guard every optional ACF, WooCommerce, or plugin API before calling it.
