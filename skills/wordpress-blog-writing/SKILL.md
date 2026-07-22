---
name: wordpress-blog-writing
description: Generate one original, publication-ready WordPress Markdown article from a centralized content tracker. Use when the wordpress-blog-writer-agent is asked to draft an approved blog topic without publishing it to WordPress.
---

# WordPress Blog Writing

## Trigger

Use only with `wordpress-blog-writer-agent` for a populated `manual-files/wordpress-blog-content-tracker.xlsx` tracker.

## Workflow

1. Select the first `pending` row with a unique ID and topic.
2. Generate direct Markdown, validate the requested word count, and reject placeholder text.
3. Write only the final Markdown artifact to `dist/wordpress-blog-writer/<blog_id>.md`.
4. Keep the tracker read-only unless the operator explicitly supplies `--approve`; then mark the selected row `complete` and set `blog_created_date`.

## Output

Never publish to WordPress, send email, or alter `uploaded` or `blog_posted_date`. Report the exact output path, selected model, and tracker status.
