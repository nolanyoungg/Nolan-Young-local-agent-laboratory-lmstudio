# Local WordPress verification rules

These rules were derived from official WordPress Theme Structure, Main Stylesheet, and Child Themes documentation reviewed on 2026-07-16. Runtime verification never fetches documentation.

- Root `style.css` with non-empty `Theme Name` is required.
- `Version`, `Text Domain`, `Requires at least`, and `Requires PHP` are validated when present and reported as recommended metadata.
- A child theme needs non-empty `Template` matching its parent directory name; unavailable parents are `BLOCKED`.
- Block and hybrid themes require `theme.json` and `templates/index.html` under this verifier's structural policy. Classic themes need `index.php` unless an available parent supplies the fallback.
- Theme PHP is linted with `php -l`; VCS, dependencies, caches, and generated directories are excluded.
- Direct missing `get_theme_file_uri()` and `get_theme_file_path()` asset references are failures.

Sources: https://developer.wordpress.org/themes/core-concepts/theme-structure/ ; https://developer.wordpress.org/themes/core-concepts/main-stylesheet/ ; https://developer.wordpress.org/themes/advanced-topics/child-themes/
