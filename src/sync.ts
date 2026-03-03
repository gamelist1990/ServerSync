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

  const server = net.createServer((socket: any) => {
    const remote = `${socket.remoteAddress ?? "unknown"}:${socket.remotePort ?? "?"}`;
    let manifest: FileManifestItem[] = [];
    let expectedFileCount = 0;
    let needed = new Set<string>();
    let deletedCount = 0;
    let writtenCount = 0;

    console.log(`[receiver] connected: ${remote}`);

    socket.on("close", () => {
      console.log(`[receiver] closed: ${remote}`);
    });

    socket.on("error", (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[receiver] socket error (${remote}): ${message}`);
    });

    const sendStatus = (phase: "scanning" | "receiving" | "finalizing"): void => {
      writeMessage(socket, {
        type: "status",
        phase,
        received: writtenCount,
        expected: expectedFileCount,
        deleted: deletedCount,
        pending: needed.size
      });
    };

    bindMessageReader(socket, async (msg: WireMessage) => {
      try {
        if (msg.type === "hello") {
          console.log(`[receiver] hello from ${remote}, project=${msg.project}`);
          return;
        }

        if (msg.type === "manifest") {
          sendStatus("scanning");
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
          expectedFileCount = needList.length;

          console.log(
            `[receiver] scan: manifest=${manifest.length} eligible=${filteredManifest.length} need=${needList.length} delete=${deleteList.length}`
          );

          for (const rel of deleteList) {
            await fs.rm(path.join(targetDir, rel), { force: true });
            deletedCount += 1;
          }

          writeMessage(socket, { type: "need", files: needList, delete: deleteList });
          sendStatus("receiving");
          return;
        }

        if (msg.type === "status") {
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
          if (writtenCount % 25 === 0 || needed.size === 0) {
            console.log(`[receiver] write progress: ${writtenCount}/${expectedFileCount} pending=${needed.size}`);
          }
          if (writtenCount % 50 === 0 || needed.size === 0) {
            sendStatus("receiving");
          }
          return;
        }

        if (msg.type === "done") {
          sendStatus("finalizing");
          console.log(`[receiver] finalizing: received=${writtenCount} deleted=${deletedCount} pending=${needed.size}`);
          writeMessage(socket, {
            type: "result",
            received: writtenCount,
            deleted: deletedCount,
            message: needed.size === 0 ? "Sync completed" : `Missing files: ${needed.size}`
          });
          socket.end();
        }
      } catch (error) {
        console.log(`[receiver] processing error (${remote}): ${error instanceof Error ? error.message : "Unknown receiver error"}`);
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
  console.log(`Preparing sync: files=${manifest.length}`);

  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: options.host, port: options.port });
    const byPath = new Map(manifest.map((f) => [f.path, f]));
    let uploadTotal = 0;
    let uploaded = 0;
    let finished = false;

    socket.once("connect", () => {
      writeMessage(socket, { type: "hello", project: path.basename(options.sourceDir) });
      writeMessage(socket, { type: "manifest", files: manifest });
      console.log(`Connected to ${options.host}:${options.port}`);
    });

    bindMessageReader(socket, async (msg: WireMessage) => {
      try {
        if (msg.type === "need") {
          uploadTotal = msg.files.length;
          uploaded = 0;
          console.log(`Receiver requested ${uploadTotal} file(s), sending...`);

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

            uploaded += 1;
            const percent = uploadTotal === 0 ? 100 : Math.round((uploaded / uploadTotal) * 100);
            console.log(`Upload progress: ${uploaded}/${uploadTotal} (${percent}%)`);
          }

          writeMessage(socket, { type: "done" });
          return;
        }

        if (msg.type === "status") {
          console.log(`Server status: phase=${msg.phase} received=${msg.received}/${msg.expected} pending=${msg.pending} deleted=${msg.deleted}`);
          return;
        }

        if (msg.type === "result") {
          console.log(`Sync result: uploaded=${msg.received} deleted=${msg.deleted}`);
          if (msg.message) {
            console.log(msg.message);
          }
          finished = true;
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
    socket.once("close", () => {
      if (!finished) {
        reject(new Error("Connection closed before sync result was received"));
      }
    });
  });
}
