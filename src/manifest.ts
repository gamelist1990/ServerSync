import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { sha1File } from "./hash.js";
import type { FileManifestItem } from "./types.js";

type WalkResult = {
  files: string[];
};

type HashCacheEntry = {
  mtimeMs: number;
  size: number;
  sha1: string;
};

type HashCache = Record<string, HashCacheEntry>;

const HASH_CONCURRENCY = 4;

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runWorker = async (): Promise<void> => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  };

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

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

  // SHA1 キャッシュを読み込む
  const cacheDir = path.join(rootDir, ".ServerSync");
  const cachePath = path.join(cacheDir, "hash-cache.json");
  let cache: HashCache = {};
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    cache = JSON.parse(raw) as HashCache;
  } catch {
    // キャッシュファイルがない / 読み込み失敗の場合は空のキャッシュから開始
  }

  const walked = await collectFiles(rootDir, filters);
  let cacheUpdated = false;

  const items = await mapConcurrent(walked.files, HASH_CONCURRENCY, async (absPath) => {
    const stat = await fs.stat(absPath);
    const rel = path.relative(rootDir, absPath).replaceAll("\\", "/");

    let sha1: string;
    const cached = cache[rel];
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      // キャッシュヒット: SHA1 再計算不要
      sha1 = cached.sha1;
    } else {
      sha1 = await sha1File(absPath);
      cache[rel] = { mtimeMs: stat.mtimeMs, size: stat.size, sha1 };
      cacheUpdated = true;
    }

    return {
      path: rel,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha1
    };
  });

  // 変更があった場合のみキャッシュを保存
  if (cacheUpdated) {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(cache), "utf8");
  }

  items.sort((a, b) => a.path.localeCompare(b.path));
  return items;
}
