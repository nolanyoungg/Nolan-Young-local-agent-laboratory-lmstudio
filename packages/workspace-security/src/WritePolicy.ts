import type { PathPolicy } from "./PathPolicy.js";

export class WritePolicy {
  readonly #pathPolicy: PathPolicy;

  public constructor(pathPolicy: PathPolicy) {
    this.#pathPolicy = pathPolicy;
  }

  public assertAllowed(relativePath: string): string {
    return this.#pathPolicy.assertAllowed(relativePath, "write");
  }

  public assertDeleteAllowed(relativePath: string): string {
    return this.#pathPolicy.assertAllowed(relativePath, "delete");
  }

  public allows(relativePath: string): boolean {
    return this.#pathPolicy.isAllowed(relativePath, "write");
  }

  public allowsDelete(relativePath: string): boolean {
    return this.#pathPolicy.isAllowed(relativePath, "delete");
  }
}
