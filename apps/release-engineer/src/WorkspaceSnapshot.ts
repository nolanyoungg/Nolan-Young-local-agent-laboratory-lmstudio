import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { validateRelativePath } from "@local-agent-lab/workspace-security";

import { ReleaseEngineerError } from "./errors.js";
import type { VirtualOverlay } from "./types.js";

export const MAX_SCANNED_ENTRIES = 100_000;
export const MAX_CHECK_FILE_BYTES = 1_048_576;

export interface SnapshotEntry {
  readonly path: string;
  readonly absolutePath: string;
  readonly kind: "directory" | "file" | "other" | "symlink";
  readonly bytes: number;
  readonly source: "disk" | "overlay";
}

function normalizeOverlay(overlay: VirtualOverlay): ReadonlyMap<string, string> {
  const normalized = new Map<string, string>();
  const portableNames = new Set<string>();
  for (const [candidatePath, content] of overlay) {
    const safePath = validateRelativePath(candidatePath.replaceAll("\\", "/"));
    const folded = safePath.toLowerCase();
    if (portableNames.has(folded)) {
      throw new ReleaseEngineerError(
        "OVERLAY_PATH_COLLISION",
        `Dry-run overlay contains a duplicate portable path: ${safePath}`,
        "security",
      );
    }
    portableNames.add(folded);
    normalized.set(safePath, content);
  }
  return normalized;
}

export class WorkspaceSnapshot {
  readonly #overlay: ReadonlyMap<string, string>;
  readonly root: string;
  #entries: readonly SnapshotEntry[] | undefined;

  public constructor(root: string, overlay: VirtualOverlay = new Map()) {
    this.root = path.resolve(root);
    this.#overlay = normalizeOverlay(overlay);
  }

  public get overlay(): ReadonlyMap<string, string> {
    return this.#overlay;
  }

  public async entries(): Promise<readonly SnapshotEntry[]> {
    if (this.#entries !== undefined) return this.#entries;
    const byPath = new Map<string, SnapshotEntry>();
    const portableNames = new Map<string, string>();
    const queue: string[] = ["."];

    while (queue.length > 0) {
      const relativeDirectory = queue.shift();
      if (relativeDirectory === undefined) break;
      const absoluteDirectory =
        relativeDirectory === "."
          ? this.root
          : path.join(this.root, ...relativeDirectory.split("/"));
      let directoryEntries;
      try {
        directoryEntries = await readdir(absoluteDirectory, { withFileTypes: true });
      } catch (error) {
        throw new ReleaseEngineerError(
          "WORKSPACE_SCAN_FAILED",
          `Workspace directory could not be read: ${relativeDirectory}`,
          "workflow",
          { cause: error },
        );
      }
      directoryEntries.sort((left, right) => left.name.localeCompare(right.name));

      for (const directoryEntry of directoryEntries) {
        const candidate =
          relativeDirectory === "."
            ? directoryEntry.name
            : `${relativeDirectory}/${directoryEntry.name}`;
        let relativePath: string;
        try {
          relativePath = validateRelativePath(candidate);
        } catch (error) {
          throw new ReleaseEngineerError(
            "UNSAFE_WORKSPACE_ENTRY",
            "Workspace contains a non-portable or unsafe path.",
            "security",
            { cause: error },
          );
        }
        const folded = relativePath.toLowerCase();
        const existingPortablePath = portableNames.get(folded);
        if (existingPortablePath !== undefined && existingPortablePath !== relativePath) {
          throw new ReleaseEngineerError(
            "PORTABLE_PATH_COLLISION",
            `Workspace paths collide on case-insensitive filesystems: ${existingPortablePath} and ${relativePath}`,
            "security",
          );
        }
        portableNames.set(folded, relativePath);

        const absolutePath = path.join(this.root, ...relativePath.split("/"));
        const stat = await lstat(absolutePath);
        const kind: SnapshotEntry["kind"] = stat.isSymbolicLink()
          ? "symlink"
          : stat.isDirectory()
            ? "directory"
            : stat.isFile()
              ? "file"
              : "other";
        byPath.set(relativePath, {
          path: relativePath,
          absolutePath,
          kind,
          bytes: stat.size,
          source: "disk",
        });
        if (kind === "directory") queue.push(relativePath);
        if (byPath.size > MAX_SCANNED_ENTRIES) {
          throw new ReleaseEngineerError(
            "WORKSPACE_TOO_LARGE",
            `Workspace contains more than ${MAX_SCANNED_ENTRIES} entries.`,
            "workflow",
          );
        }
      }
    }

    for (const [relativePath, content] of this.#overlay) {
      const folded = relativePath.toLowerCase();
      const existingPortablePath = portableNames.get(folded);
      if (existingPortablePath !== undefined && existingPortablePath !== relativePath) {
        throw new ReleaseEngineerError(
          "PORTABLE_PATH_COLLISION",
          `Overlay path collides with ${existingPortablePath}: ${relativePath}`,
          "security",
        );
      }
      portableNames.set(folded, relativePath);
      byPath.set(relativePath, {
        path: relativePath,
        absolutePath: path.join(this.root, ...relativePath.split("/")),
        kind: "file",
        bytes: Buffer.byteLength(content, "utf8"),
        source: "overlay",
      });
    }

    this.#entries = [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
    return this.#entries;
  }

  public async entry(relativePath: string): Promise<SnapshotEntry | undefined> {
    const normalized = validateRelativePath(relativePath);
    const folded = normalized.toLowerCase();
    return (await this.entries()).find((candidate) => candidate.path.toLowerCase() === folded);
  }

  public async readText(relativePath: string): Promise<string> {
    const normalized = validateRelativePath(relativePath);
    const overlayContent = this.#overlay.get(normalized);
    if (overlayContent !== undefined) return overlayContent;
    const entry = await this.entry(normalized);
    if (entry === undefined || entry.kind !== "file") {
      throw new ReleaseEngineerError(
        "REQUIRED_FILE_UNREADABLE",
        `Required regular file is unavailable: ${normalized}`,
        "workflow",
      );
    }
    if (entry.bytes > MAX_CHECK_FILE_BYTES) {
      throw new ReleaseEngineerError(
        "CHECK_FILE_TOO_LARGE",
        `File exceeds the ${MAX_CHECK_FILE_BYTES}-byte check limit: ${normalized}`,
        "workflow",
      );
    }
    const bytes = await readFile(entry.absolutePath);
    if (bytes.includes(0)) {
      throw new ReleaseEngineerError(
        "INVALID_TEXT_FILE",
        `File contains a NUL byte: ${normalized}`,
        "workflow",
      );
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new ReleaseEngineerError(
        "INVALID_TEXT_FILE",
        `File is not valid UTF-8: ${normalized}`,
        "workflow",
        { cause: error },
      );
    }
  }
}
