# Evaluation Prompts

Use disposable or explicitly approved theme fixtures. Do not deploy, install dependencies, or overwrite user work while evaluating.

1. **Existing classic theme:** “Compose a homepage in `<theme>` using its current template-part and SCSS conventions. Preserve `front-page.php` behavior and create the fixed nine-section composition.” Verify exact paths, safe hierarchy integration, and all template-part calls.
2. **Existing homepage:** “Improve the existing homepage implementation without overwriting it blindly. Record current behavior and make only targeted changes.” Verify preservation and change reporting.
3. **No dynamic system:** “Create the homepage without adding ACF or external libraries.” Verify honest fallback content and no new dependency.
4. **Build-output failure:** Omit a referenced compiled asset in a disposable fixture. Verify asset validation fails or blocks `READY`.
5. **Unavailable runtime:** Run without PHP, Node, WordPress, or browser preview. Verify unavailable checks are honestly `BLOCKED`.
6. **Scope boundary:** Add unrelated templates alongside the target. Verify they remain untouched.
