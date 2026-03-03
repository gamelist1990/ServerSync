import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolveSettingsDir, resolveSettingsFile } from "./paths.js";
import type { Settings } from "./types.js";

const DEFAULT_SETTINGS: Settings = {
  filters: [],
  profiles: {}
};

function normalizeFilterValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const unquoted = trimmed.replace(/^['\"]+|['\"]+$/g, "");
  return unquoted.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function sanitizeSettings(input: Partial<Settings>): { value: Settings; changed: boolean } {
  let changed = false;

  const rawFilters = Array.isArray(input.filters) ? input.filters : [];
  if (!Array.isArray(input.filters)) {
    changed = true;
  }

  const filters: string[] = [];
  const seen = new Set<string>();
  for (const entry of rawFilters) {
    if (typeof entry !== "string") {
      changed = true;
      continue;
    }

    const normalized = normalizeFilterValue(entry);
    if (!normalized) {
      changed = true;
      continue;
    }

    if (normalized !== entry) {
      changed = true;
    }

    if (!seen.has(normalized)) {
      filters.push(normalized);
      seen.add(normalized);
    } else {
      changed = true;
    }
  }

  const profiles: Settings["profiles"] = {};
  if (input.profiles && typeof input.profiles === "object") {
    for (const [name, profile] of Object.entries(input.profiles)) {
      if (!profile || typeof profile !== "object") {
        changed = true;
        continue;
      }

      const hostRaw = (profile as { host?: unknown }).host;
      const portRaw = (profile as { port?: unknown }).port;
      const host = typeof hostRaw === "string" ? hostRaw.trim() : "";
      const port = Number(portRaw);

      if (!host || !Number.isFinite(port) || port <= 0) {
        changed = true;
        continue;
      }

      profiles[name] = { host, port };
    }
  } else if (input.profiles !== undefined) {
    changed = true;
  }

  let lastTarget: Settings["lastTarget"];
  if (input.lastTarget && typeof input.lastTarget === "object") {
    const hostRaw = (input.lastTarget as { host?: unknown }).host;
    const portRaw = (input.lastTarget as { port?: unknown }).port;
    const host = typeof hostRaw === "string" ? hostRaw.trim() : "";
    const port = Number(portRaw);
    if (host && Number.isFinite(port) && port > 0) {
      lastTarget = { host, port };
    } else {
      changed = true;
    }
  }

  return {
    value: {
      filters,
      profiles,
      ...(lastTarget ? { lastTarget } : {})
    },
    changed
  };
}

export async function loadSettings(cwd = process.cwd()): Promise<Settings> {
  const filePath = resolveSettingsFile(cwd);
  if (!existsSync(filePath)) {
    await ensureSettings(cwd);
    return { ...DEFAULT_SETTINGS };
  }
  const raw = await fs.readFile(filePath, "utf8");
  let parsed: Partial<Settings>;
  try {
    parsed = JSON.parse(raw) as Partial<Settings>;
  } catch {
    await saveSettings(DEFAULT_SETTINGS, cwd);
    return { ...DEFAULT_SETTINGS };
  }

  const sanitized = sanitizeSettings(parsed);
  if (sanitized.changed) {
    await saveSettings(sanitized.value, cwd);
  }

  return sanitized.value;
}

export async function saveSettings(settings: Settings, cwd = process.cwd()): Promise<void> {
  await ensureSettings(cwd);
  const filePath = resolveSettingsFile(cwd);
  await fs.writeFile(filePath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export async function ensureSettings(cwd = process.cwd()): Promise<void> {
  const settingsDir = resolveSettingsDir(cwd);
  if (!existsSync(settingsDir)) {
    await fs.mkdir(settingsDir, { recursive: true });
  }

  const settingsFile = resolveSettingsFile(cwd);
  if (!existsSync(settingsFile)) {
    await fs.writeFile(settingsFile, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`, "utf8");
  }
}
