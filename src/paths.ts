import path from "node:path";

export const SETTINGS_DIR_NAME = ".ServerSync";
export const SETTINGS_FILE = "settings.json";

export function resolveSettingsDir(cwd = process.cwd()): string {
  return path.join(cwd, SETTINGS_DIR_NAME);
}

export function resolveSettingsFile(cwd = process.cwd()): string {
  return path.join(resolveSettingsDir(cwd), SETTINGS_FILE);
}
