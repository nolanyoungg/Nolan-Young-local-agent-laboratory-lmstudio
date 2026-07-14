import { lstat } from "node:fs/promises";

import type { WorkspaceGuard } from "@local-agent-lab/workspace-security";

import { ReleaseEngineerError } from "./errors.js";
import { matchesAnyGlob } from "./glob.js";
import { sha256Bytes, sha256File } from "./hash.js";
import type {
  PackageManifest,
  PackageManifestEntry,
  PackageMetadata,
  PackagePolicy,
} from "./types.js";
import type { WorkspaceSnapshot } from "./WorkspaceSnapshot.js";

export class PackageManifestBuilder {
  public constructor(
    private readonly policy: PackagePolicy,
    private readonly workspaceGuard: WorkspaceGuard,
  ) {}

  public async build(
    snapshot: WorkspaceSnapshot,
    metadata: PackageMetadata,
  ): Promise<BuiltPackageManifest> {
    const selected = (await snapshot.entries()).filter(
      (entry) =>
        entry.kind === "file" &&
        matchesAnyGlob(entry.path, this.policy.include) &&
        !matchesAnyGlob(entry.path, this.policy.exclude),
    );
    if (selected.length > this.policy.maximumEntries) {
      throw new ReleaseEngineerError(
        "PACKAGE_ENTRY_LIMIT",
        `Planned package has ${selected.length} entries; maximum is ${this.policy.maximumEntries}.`,
        "workflow",
      );
    }

    const entries: PackageManifestEntry[] = [];
    const sources = new Map<string, PackageManifestSource>();
    let totalBytes = 0;
    for (const selectedEntry of selected) {
      let manifestEntry: PackageManifestEntry;
      const overlayContent = snapshot.overlay.get(selectedEntry.path);
      if (overlayContent !== undefined) {
        const bytes = Buffer.byteLength(overlayContent, "utf8");
        manifestEntry = {
          path: selectedEntry.path,
          bytes,
          sha256: sha256Bytes(overlayContent),
          source: "overlay",
        };
        sources.set(selectedEntry.path, { content: overlayContent });
      } else {
        const guarded = await this.workspaceGuard.resolveForRead(selectedEntry.path);
        const stat = await lstat(guarded.absolutePath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new ReleaseEngineerError(
            "PACKAGE_SOURCE_CHANGED",
            `Package source stopped being a regular file: ${selectedEntry.path}`,
            "security",
          );
        }
        manifestEntry = {
          path: guarded.relativePath,
          bytes: stat.size,
          sha256: await sha256File(guarded.absolutePath),
          source: "disk",
        };
        sources.set(guarded.relativePath, { absolutePath: guarded.absolutePath });
      }
      totalBytes += manifestEntry.bytes;
      if (totalBytes > this.policy.maximumArchiveBytes) {
        throw new ReleaseEngineerError(
          "PACKAGE_SIZE_LIMIT",
          `Planned package exceeds ${this.policy.maximumArchiveBytes} bytes.`,
          "workflow",
        );
      }
      entries.push(manifestEntry);
    }

    entries.sort((left, right) => left.path.localeCompare(right.path));
    if (entries.length === 0) {
      throw new ReleaseEngineerError(
        "PACKAGE_EMPTY",
        "The trusted package policy selected no regular files.",
        "workflow",
      );
    }
    const portablePaths = new Set<string>();
    for (const entry of entries) {
      const folded = entry.path.toLowerCase();
      if (portablePaths.has(folded)) {
        throw new ReleaseEngineerError(
          "PACKAGE_DUPLICATE_ENTRY",
          `Package manifest contains a duplicate portable path: ${entry.path}`,
          "security",
        );
      }
      portablePaths.add(folded);
    }

    return {
      manifest: {
        packageName: metadata.name,
        packageVersion: metadata.version,
        entries,
        totalBytes,
      },
      sources,
    };
  }
}

export interface PackageManifestSource {
  readonly absolutePath?: string;
  readonly content?: string;
}

export interface BuiltPackageManifest {
  readonly manifest: PackageManifest;
  readonly sources: ReadonlyMap<string, PackageManifestSource>;
}

export function serializableManifest(manifest: PackageManifest): unknown {
  return {
    packageName: manifest.packageName,
    packageVersion: manifest.packageVersion,
    totalBytes: manifest.totalBytes,
    entries: manifest.entries.map(({ path, bytes, sha256, source }) => ({
      path,
      bytes,
      sha256,
      source,
    })),
  };
}
