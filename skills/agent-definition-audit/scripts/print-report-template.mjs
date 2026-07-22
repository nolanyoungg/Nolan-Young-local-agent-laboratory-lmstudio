import { readFile } from "node:fs/promises";

const template = new URL("../assets/report-template.md", import.meta.url);
process.stdout.write(await readFile(template, "utf8"));
