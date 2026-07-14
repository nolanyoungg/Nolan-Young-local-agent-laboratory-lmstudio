import type { PathPolicy } from "./PathPolicy.js";

export class ReadPolicy {
  readonly #pathPolicy: PathPolicy;

  public constructor(pathPolicy: PathPolicy) {
    this.#pathPolicy = pathPolicy;
  }

  public assertAllowed(relativePath: string): string {
    return this.#pathPolicy.assertAllowed(relativePath, "read");
  }

  public allows(relativePath: string): boolean {
    return this.#pathPolicy.isAllowed(relativePath, "read");
  }
}
