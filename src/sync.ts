import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { buildManifest, collectFiles } from "./manifest.js";
import { shouldSkip } from "./manifest.js";
import { sha1Buffer, sha1File } from "./hash.js";
import { bindMessageReader, writeMessage } from "./wire.js";
import type { FileManifestItem, WireMessage } from "./types.js";

async function listDestinationFiles(rootDir: string, filters: string[]): Promise<string[]> {
  const walked = await collectFiles(rootDir, filters);
  return walked.files.map((abs) => path.relative(rootDir, abs).replaceAll("\\", "/"));
}

export async function startReceiver(port: number, targetDir: string, filters: string[] = []): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });

  const server = net.createServer((socket) => {
    let manifest: FileManifestItem[] = [];
    let needed = new Set<string>();
    let deletedCount = 0;
    let writtenCount = 0;

    bindMessageReader(socket, async (msg: WireMessage) => {
      try {
        if (msg.type === "hello") {
          return;
        }

        if (msg.type === "manifest") {
          manifest = msg.files;
          const filteredManifest = manifest.filter((f) => !shouldSkip(f.path, filters, targetDir));
          const expected = new Set(filteredManifest.map((f) => f.path));
          const destinationFiles = existsSync(targetDir) ? await listDestinationFiles(targetDir, filters) : [];

          const deleteList = destinationFiles.filter((p) => !expected.has(p));

          const needList: string[] = [];
          for (const file of filteredManifest) {
            const absPath = path.join(targetDir, file.path);
            if (!existsSync(absPath)) {
              needList.push(file.path);
              continue;
            }

            const currentHash = await sha1File(absPath);
            if (currentHash !== file.sha1) {
              needList.push(file.path);
            }
          }

          needed = new Set(needList);

          for (const rel of deleteList) {
            await fs.rm(path.join(targetDir, rel), { force: true });
            deletedCount += 1;
          }

          writeMessage(socket, { type: "need", files: needList, delete: deleteList });
          return;
        }

        if (msg.type === "file") {
          if (!needed.has(msg.path)) {
            return;
          }

          const absPath = path.join(targetDir, msg.path);
          const data = Buffer.from(msg.dataBase64, "base64");
          const actualHash = sha1Buffer(data);
          if (actualHash !== msg.sha1) {
            writeMessage(socket, { type: "error", message: `Hash mismatch: ${msg.path}` });
            socket.end();
            return;
          }

          await fs.mkdir(path.dirname(absPath), { recursive: true });
          await fs.writeFile(absPath, data);
          writtenCount += 1;
          needed.delete(msg.path);
          return;
        }

        if (msg.type === "done") {
          writeMessage(socket, {
            type: "result",
            received: writtenCount,
            deleted: deletedCount,
            message: needed.size === 0 ? "Sync completed" : `Missing files: ${needed.size}`
          });
          socket.end();
        }
      } catch (error) {
        writeMessage(socket, {
          type: "error",
          message: error instanceof Error ? error.message : "Unknown receiver error"
        });
        socket.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve());
  });

  console.log(`Receiver listening on port ${port}`);
  console.log(`Target dir: ${targetDir}`);
  console.log(`Host: ${os.hostname()}`);
}

export async function pushToReceiver(options: {
  host: string;
  port: number;
  sourceDir: string;
}): Promise<void> {
  const manifest = await buildManifest(options.sourceDir, []);

  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: options.host, port: options.port });
    const byPath = new Map(manifest.map((f) => [f.path, f]));

    socket.once("connect", () => {
      writeMessage(socket, { type: "hello", project: path.basename(options.sourceDir) });
      writeMessage(socket, { type: "manifest", files: manifest });
    });

    bindMessageReader(socket, async (msg: WireMessage) => {
      try {
        if (msg.type === "need") {
          for (const relPath of msg.files) {
            const info = byPath.get(relPath);
            if (!info) continue;

            const abs = path.join(options.sourceDir, relPath);
            const data = await fs.readFile(abs);
            writeMessage(socket, {
              type: "file",
              path: relPath,
              dataBase64: data.toString("base64"),
              sha1: info.sha1
            });
          }

          writeMessage(socket, { type: "done" });
          return;
        }

        if (msg.type === "result") {
          console.log(`Sync result: uploaded=${msg.received} deleted=${msg.deleted}`);
          if (msg.message) {
            console.log(msg.message);
          }
          socket.end();
          resolve();
          return;
        }

        if (msg.type === "error") {
          reject(new Error(msg.message));
          socket.end();
        }
      } catch (error) {
        reject(error);
        socket.end();
      }
    });

    socket.once("error", reject);
  });
}
