# WordPress Theme File Review

Use the local deterministic reviewer. Its local rules follow the WordPress Theme Handbook: a recognizable theme has a root `style.css` with `Theme Name`; block themes require `templates/index.html`; `theme.json`, `parts/`, `patterns/`, and `styles/` are optional where the handbook says so; and a child theme's `Template` names its parent directory.

Report confirmed local syntax, required-file, and reference failures as `FAIL`; unavailable tools and parent themes as `BLOCKED` or `UNVERIFIED`; and static security or build observations as `WARN`. Do not claim static inspection proves rendering, runtime integrations, complete security, or WordPress.org submission eligibility.
