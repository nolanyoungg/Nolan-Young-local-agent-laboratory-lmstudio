import { readFile } from "node:fs/promises";

process.stdout.write(
  await readFile(new URL("../assets/report-template.md", import.meta.url), "utf8"),
);
