import { minimatch } from "minimatch";

export function matchesAnyGlob(relativePath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    minimatch(relativePath, pattern, {
      dot: true,
      nocase: true,
      nocomment: true,
      nonegate: true,
    }),
  );
}
