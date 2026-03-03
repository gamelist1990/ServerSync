import fs from "node:fs/promises";
import crypto from "node:crypto";

export async function sha1File(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha1").update(data).digest("hex");
}

export function sha1Buffer(data: Buffer): string {
  return crypto.createHash("sha1").update(data).digest("hex");
}
