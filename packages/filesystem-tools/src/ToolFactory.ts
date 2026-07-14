import { ApplyPatchTool } from "./ApplyPatchTool.js";
import { CreateFileTool } from "./CreateFileTool.js";
import { DryRunOverlay } from "./DryRunOverlay.js";
import { ListFilesTool } from "./ListFilesTool.js";
import { ReadFileMetadataTool } from "./ReadFileMetadataTool.js";
import { ReadFileTool } from "./ReadFileTool.js";
import { SearchTextTool } from "./SearchTextTool.js";
import { WriteFileTool } from "./WriteFileTool.js";
import type { WorkspaceGuardLike } from "./types.js";

export interface FilesystemToolSet {
  readonly listFiles: ListFilesTool;
  readonly readFile: ReadFileTool;
  readonly searchText: SearchTextTool;
  readonly writeFile: WriteFileTool;
  readonly createFile: CreateFileTool;
  readonly applyPatch: ApplyPatchTool;
  readonly readFileMetadata: ReadFileMetadataTool;
  readonly overlay: DryRunOverlay;
}

export class ToolFactory {
  public static create(
    workspaceGuard: WorkspaceGuardLike,
    options: Readonly<{ dryRun?: boolean }> = {},
  ): FilesystemToolSet {
    const overlay = new DryRunOverlay();
    const dependencies = {
      workspaceGuard,
      dryRun: options.dryRun ?? false,
      overlay,
    } as const;

    return Object.freeze({
      listFiles: new ListFilesTool(dependencies),
      readFile: new ReadFileTool(dependencies),
      searchText: new SearchTextTool(dependencies),
      writeFile: new WriteFileTool(dependencies),
      createFile: new CreateFileTool(dependencies),
      applyPatch: new ApplyPatchTool(dependencies),
      readFileMetadata: new ReadFileMetadataTool(dependencies),
      overlay,
    });
  }
}
