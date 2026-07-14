import { posix } from "node:path";
import type { DryRunOverlayLike } from "./types.js";

export class DryRunOverlay implements DryRunOverlayLike {
  readonly #files = new Map<string, string>();

  public has(relativePath: string): boolean {
    return this.#files.has(normalizeKey(relativePath));
  }

  public get(relativePath: string): string | undefined {
    return this.#files.get(normalizeKey(relativePath));
  }

  public set(relativePath: string, content: string): void {
    this.#files.set(normalizeKey(relativePath), content);
  }

  public entries(): readonly (readonly [string, string])[] {
    return [...this.#files.entries()].sort(([left], [right]) => left.localeCompare(right));
  }
}

function normalizeKey(relativePath: string): string {
  return posix.normalize(relativePath.replaceAll("\\", "/")).replace(/^\.\//u, "");
}
