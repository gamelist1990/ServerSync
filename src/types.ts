export type FileManifestItem = {
  path: string;
  size: number;
  mtimeMs: number;
  sha1: string;
};

export type Settings = {
  filters: string[];
  profiles: Record<string, { host: string; port: number }>;
  lastTarget?: { host: string; port: number };
};

export type WireMessage =
  | { type: "hello"; project: string }
  | { type: "manifest"; files: FileManifestItem[] }
  | { type: "need"; files: string[]; delete: string[] }
  | { type: "file"; path: string; dataBase64: string; sha1: string }
  | { type: "done" }
  | { type: "result"; received: number; deleted: number; message?: string }
  | { type: "error"; message: string };
