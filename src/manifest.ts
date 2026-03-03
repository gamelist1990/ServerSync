import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { sha1File } from "./hash.js";
import type { FileManifestItem } from "./types.js";

type WalkResult = {
  files: string[];
};

function normalizeFilterForRoot(rawFilter: string, rootDir: string): string {
  const cleaned = rawFilter.trim().replace(/^['\"]+|['\"]+$/g, "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!cleaned) return "";

  const isAbsoluteUnix = cleaned.startsWith("/");
  const isAbsoluteWindows = /^[A-Za-z]:\//.test(cleaned);
  if (!isAbsoluteUnix && !isAbsoluteWindows) {
    return cleaned.replace(/\/+$/, "");
  }

  const rel = path.relative(rootDir, cleaned).replaceAll("\\", "/");
  if (!rel.startsWith("../") && rel !== "..") {
    return rel.replace(/^\.\//, "").replace(/\/+$/, "");
  }

  return cleaned.replace(/\/+$/, "");
}

export function shouldSkip(relativePath: string, filters: string[], rootDir: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  if (normalized.startsWith(".ServerSync/")) {
    return true;
  }

  return filters.some((rawFilter) => {
    const filter = normalizeFilterForRoot(rawFilter, rootDir);
    if (!filter) return false;
    return normalized === filter || normalized.startsWith(`${filter}/`);
  });
}

export async function collectFiles(rootDir: string, filters: string[]): Promise<WalkResult> {
  const queue = [rootDir];
  const files: string[] = [];

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) continue;

    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      const rel = path.relative(rootDir, abs);

      if (shouldSkip(rel, filters, rootDir)) {
        continue;
      }

      if (entry.isDirectory()) {
        queue.push(abs);
        continue;
      }

      if (entry.isFile()) {
        files.push(abs);
      }
    }
  }

  return { files };
}

export async function buildManifest(rootDir: string, filters: string[]): Promise<FileManifestItem[]> {
  if (!existsSync(rootDir)) {
    throw new Error(`Source path does not exist: ${rootDir}`);
  }

  const walked = await collectFiles(rootDir, filters);
  const items: FileManifestItem[] = [];

  for (const absPath of walked.files) {
    const stat = await fs.stat(absPath);
    const rel = path.relative(rootDir, absPath).replaceAll("\\", "/");
    items.push({
      path: rel,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha1: await sha1File(absPath)
    });
  }

  items.sort((a, b) => a.path.localeCompare(b.path));
  return items;
}
