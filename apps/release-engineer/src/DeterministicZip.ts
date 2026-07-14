import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { validateRelativePath, type WorkspaceGuard } from "@local-agent-lab/workspace-security";
import * as yauzl from "yauzl";
import { ZipFile } from "yazl";

import { ReleaseEngineerError } from "./errors.js";
import { matchesAnyGlob } from "./glob.js";
import type { BuiltPackageManifest } from "./PackageManifestBuilder.js";
import type { ArchiveInspection, ArchiveInspectionEntry, PackageManifest } from "./types.js";

const NORMALIZED_ZIP_TIME = new Date("1980-01-01T00:00:00.000Z");
const NORMALIZED_FILE_MODE = 0o100644;

function safeArchiveStem(packageName: string, version: string): string {
  const normalized = `${packageName.replace(/^@/u, "").replaceAll("/", "-")}-${version}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (normalized.length === 0 || normalized.length > 180) {
    throw new ReleaseEngineerError(
      "ARCHIVE_NAME_INVALID",
      "Validated package metadata cannot be converted to a safe archive name.",
      "workflow",
    );
  }
  return normalized;
}

export function archiveFileName(manifest: PackageManifest): string {
  return `${safeArchiveStem(manifest.packageName, manifest.packageVersion)}.zip`;
}

export class DeterministicZipWriter {
  public constructor(private readonly workspaceGuard: WorkspaceGuard) {}

  public async write(build: BuiltPackageManifest, artifactsDirectory: string): Promise<string> {
    const { manifest } = build;
    const archivePath = path.join(artifactsDirectory, archiveFileName(manifest));
    const temporaryPath = `${archivePath}.${randomUUID()}.tmp`;
    const zip = new ZipFile();
    const output = pipeline(
      zip.outputStream,
      createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
    );
    let ended = false;

    try {
      for (const entry of manifest.entries) {
        const source = build.sources.get(entry.path);
        if (source === undefined) {
          throw new ReleaseEngineerError(
            "PACKAGE_SOURCE_MISSING",
            `Package source is unavailable for ${entry.path}.`,
            "infrastructure",
          );
        }
        if (entry.source === "overlay") {
          if (source.content === undefined) {
            throw new ReleaseEngineerError(
              "OVERLAY_CONTENT_MISSING",
              `Overlay content is unavailable for ${entry.path}.`,
              "infrastructure",
            );
          }
          zip.addBuffer(Buffer.from(source.content, "utf8"), entry.path, {
            compress: false,
            mode: NORMALIZED_FILE_MODE,
            mtime: NORMALIZED_ZIP_TIME,
          });
        } else {
          const guarded = await this.workspaceGuard.resolveForRead(entry.path);
          const stat = await lstat(guarded.absolutePath);
          if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new ReleaseEngineerError(
              "PACKAGE_SOURCE_CHANGED",
              `Package source stopped being a regular file: ${entry.path}`,
              "security",
            );
          }
          zip.addFile(guarded.absolutePath, entry.path, {
            compress: false,
            mode: NORMALIZED_FILE_MODE,
            mtime: NORMALIZED_ZIP_TIME,
          });
        }
      }
      zip.end({ forceZip64Format: false, comment: "" });
      ended = true;
      await output;
      await rename(temporaryPath, archivePath);
      return archivePath;
    } catch (error) {
      if (!ended) zip.end();
      await output.catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (error instanceof ReleaseEngineerError) throw error;
      throw new ReleaseEngineerError(
        "ARCHIVE_WRITE_FAILED",
        "The deterministic ZIP archive could not be written.",
        "infrastructure",
        { cause: error },
      );
    }
  }
}

function openZip(archivePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      archivePath,
      { autoClose: false, decodeStrings: true, lazyEntries: true, validateEntrySizes: true },
      (error, zip) => {
        if (error !== null) {
          reject(error);
          return;
        }
        if (zip === undefined) {
          reject(new Error("ZIP reader returned no archive handle."));
          return;
        }
        resolve(zip);
      },
    );
  });
}

function openEntryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error !== null) {
        reject(error);
        return;
      }
      if (stream === undefined) {
        reject(new Error("ZIP reader returned no entry stream."));
        return;
      }
      resolve(stream);
    });
  });
}

async function digestEntry(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
): Promise<{ readonly bytes: number; readonly sha256: string }> {
  const stream = await openEntryStream(zip, entry);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    hash.update(buffer);
  }
  return { bytes, sha256: hash.digest("hex") };
}

function assertSafeArchivePath(fileName: string): string {
  if (
    fileName.includes("\\") ||
    fileName.includes("\0") ||
    fileName.endsWith("/") ||
    fileName.startsWith("/")
  ) {
    throw new ReleaseEngineerError(
      "ARCHIVE_PATH_INVALID",
      "ZIP contains a directory, absolute, backslash, or NUL-bearing entry.",
      "security",
    );
  }
  try {
    return validateRelativePath(fileName);
  } catch (error) {
    throw new ReleaseEngineerError(
      "ARCHIVE_PATH_INVALID",
      "ZIP contains an unsafe or non-portable entry path.",
      "security",
      { cause: error },
    );
  }
}

export class ArchiveInspector {
  public async inspect(
    archivePath: string,
    manifest: PackageManifest,
    forbiddenGlobs: readonly string[],
  ): Promise<ArchiveInspection> {
    const expected = new Map(
      manifest.entries.map((entry) => [entry.path.toLowerCase(), entry] as const),
    );
    const seen = new Set<string>();
    const inspected: ArchiveInspectionEntry[] = [];
    const archiveStat = await lstat(archivePath);
    if (archiveStat.isSymbolicLink() || !archiveStat.isFile()) {
      throw new ReleaseEngineerError(
        "ARCHIVE_NOT_REGULAR",
        "Generated archive is not a regular file.",
        "security",
      );
    }

    let zip: yauzl.ZipFile | undefined;
    try {
      zip = await openZip(archivePath);
      await new Promise<void>((resolve, reject) => {
        let processing = false;
        const fail = (error: unknown): void => {
          reject(error);
        };
        zip?.once("error", fail);
        zip?.once("end", () => {
          if (!processing) resolve();
        });
        zip?.on("entry", (entry: yauzl.Entry) => {
          processing = true;
          void (async () => {
            const safePath = assertSafeArchivePath(entry.fileName);
            const folded = safePath.toLowerCase();
            if (seen.has(folded)) {
              throw new ReleaseEngineerError(
                "ARCHIVE_DUPLICATE_ENTRY",
                `ZIP contains a duplicate portable path: ${safePath}`,
                "security",
              );
            }
            seen.add(folded);
            if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
              throw new ReleaseEngineerError(
                "ARCHIVE_ENCRYPTED_ENTRY",
                `ZIP contains an encrypted entry: ${safePath}`,
                "security",
              );
            }
            const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
            const fileType = unixMode & 0o170000;
            const dosDirectory = (entry.externalFileAttributes & 0x10) !== 0;
            if (dosDirectory || (fileType !== 0 && fileType !== 0o100000)) {
              throw new ReleaseEngineerError(
                "ARCHIVE_NON_REGULAR_ENTRY",
                `ZIP contains a non-regular entry: ${safePath}`,
                "security",
              );
            }
            if (matchesAnyGlob(safePath, forbiddenGlobs)) {
              throw new ReleaseEngineerError(
                "ARCHIVE_FORBIDDEN_ENTRY",
                `ZIP contains a forbidden entry: ${safePath}`,
                "security",
              );
            }
            const expectedEntry = expected.get(folded);
            if (expectedEntry === undefined || expectedEntry.path !== safePath) {
              throw new ReleaseEngineerError(
                "ARCHIVE_UNEXPECTED_ENTRY",
                `ZIP entry is absent from the validated manifest: ${safePath}`,
                "security",
              );
            }
            if (entry.uncompressedSize !== expectedEntry.bytes) {
              throw new ReleaseEngineerError(
                "ARCHIVE_SIZE_MISMATCH",
                `ZIP entry size differs from the manifest: ${safePath}`,
                "workflow",
              );
            }
            const digest = await digestEntry(zip as yauzl.ZipFile, entry);
            if (digest.bytes !== expectedEntry.bytes || digest.sha256 !== expectedEntry.sha256) {
              throw new ReleaseEngineerError(
                "ARCHIVE_HASH_MISMATCH",
                `ZIP entry content differs from the validated manifest: ${safePath}`,
                "workflow",
              );
            }
            inspected.push({
              path: safePath,
              bytes: digest.bytes,
              sha256: digest.sha256,
              crc32: entry.crc32,
            });
            processing = false;
            zip?.readEntry();
          })().catch(fail);
        });
        zip?.readEntry();
      });
    } catch (error) {
      if (error instanceof ReleaseEngineerError) throw error;
      throw new ReleaseEngineerError(
        "ARCHIVE_INSPECTION_FAILED",
        "Generated ZIP could not be inspected safely.",
        "workflow",
        { cause: error },
      );
    } finally {
      zip?.close();
    }

    if (seen.size !== expected.size) {
      const missing = [...expected.values()]
        .filter((entry) => !seen.has(entry.path.toLowerCase()))
        .map((entry) => entry.path)
        .slice(0, 8);
      throw new ReleaseEngineerError(
        "ARCHIVE_MANIFEST_MISMATCH",
        `ZIP is missing validated manifest entries: ${missing.join(", ")}`,
        "workflow",
      );
    }
    inspected.sort((left, right) => left.path.localeCompare(right.path));
    return {
      valid: true,
      archivePath,
      archiveBytes: archiveStat.size,
      entries: inspected,
    };
  }
}
