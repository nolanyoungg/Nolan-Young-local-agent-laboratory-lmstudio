import { copyFile, mkdir } from "node:fs/promises";
import { basename, resolve } from "node:path";

export const publishFinalArtifact = async (input: {
  readonly root: string;
  readonly producerId: string;
  readonly reportPath: string;
}): Promise<string> => {
  const directory = resolve(input.root, "dist", input.producerId);
  await mkdir(directory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[-:.]/gu, "");
  const destination = resolve(directory, `${timestamp}-${basename(input.reportPath)}`);
  await copyFile(input.reportPath, destination);
  return destination;
};
