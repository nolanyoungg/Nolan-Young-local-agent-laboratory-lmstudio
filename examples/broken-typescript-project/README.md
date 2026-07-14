# Broken TypeScript Project

An intentionally failing fixture. `parseNumericInput` returns a string while promising a number.

```bash
npm run build-assistant -- --workspace ./examples/broken-typescript-project --command build --mode dry-run --mock
npm run code-editor -- --workspace ./examples/broken-typescript-project --task "Add robust numeric input validation to the calculator" --mode dry-run
```

The root TypeScript build excludes this directory deliberately.
