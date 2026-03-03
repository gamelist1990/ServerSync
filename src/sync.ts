import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import cliProgress from "cli-progress";
import Table from "cli-table3";
import { buildManifest, collectFiles } from "./manifest.js";
import { shouldSkip } from "./manifest.js";
import { sha1Buffer, sha1File } from "./hash.js";
import { bindMessageReader, writeMessage } from "./wire.js";
import type { FileManifestItem, WireMessage } from "./types.js";

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let idx = 0;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx += 1;
  }
  return `${size.toFixed(idx === 0 ? 0 : 2)} ${units[idx]}`;
}

function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

async function writeMessageAsync(socket: net.Socket, msg: WireMessage): Promise<void> {
  const payload = `${JSON.stringify(msg)}\n`;
  await new Promise<void>((resolve, reject) => {
    socket.write(payload, "utf8", (error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

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

    console.log(chalk.cyan(`[receiver] connected: ${remote}`));

    socket.on("close", () => {
      console.log(chalk.gray(`[receiver] closed: ${remote}`));
    });

    socket.on("error", (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.log(chalk.red(`[receiver] socket error (${remote}): ${message}`));
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
          console.log(chalk.cyan(`[receiver] hello from ${remote}, project=${msg.project}`));
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
            chalk.cyan(
              `[receiver] scan: manifest=${manifest.length} eligible=${filteredManifest.length} need=${needList.length} delete=${deleteList.length}`
            )
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
            console.log(chalk.cyan(`[receiver] write progress: ${writtenCount}/${expectedFileCount} pending=${needed.size}`));
          }
          if (writtenCount % 50 === 0 || needed.size === 0) {
            sendStatus("receiving");
          }
          return;
        }

        if (msg.type === "done") {
          sendStatus("finalizing");
          console.log(chalk.green(`[receiver] finalizing: received=${writtenCount} deleted=${deletedCount} pending=${needed.size}`));
          writeMessage(socket, {
            type: "result",
            received: writtenCount,
            deleted: deletedCount,
            message: needed.size === 0 ? "Sync completed" : `Missing files: ${needed.size}`
          });
          socket.end();
        }
      } catch (error) {
        console.log(
          chalk.red(`[receiver] processing error (${remote}): ${error instanceof Error ? error.message : "Unknown receiver error"}`)
        );
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

  console.log(chalk.green(`Receiver listening on port ${port}`));
  console.log(chalk.green(`Target dir: ${targetDir}`));
  console.log(chalk.green(`Host: ${os.hostname()}`));
}

export async function pushToReceiver(options: {
  host: string;
  port: number;
  sourceDir: string;
}): Promise<void> {
  const manifest = await buildManifest(options.sourceDir, []);
  console.log(chalk.cyan(`Preparing sync: files=${manifest.length}`));

  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: options.host, port: options.port });
    const byPath = new Map(manifest.map((f) => [f.path, f]));
    let uploadFiles = 0;
    let uploadedFiles = 0;
    let uploadBytes = 0;
    let uploadedBytes = 0;
    let uploadStartedAt = 0;
    let lastSpeedMbps = 0;
    let finished = false;
    let progressBar: any;
    let serverStatus: Extract<WireMessage, { type: "status" }> | undefined;

    const renderStatusTable = (): void => {
      const table = new Table({ head: [chalk.cyan("Metric"), chalk.cyan("Value")] });
      table.push(["Uploaded files", `${uploadedFiles}/${uploadFiles}`]);
      table.push(["Uploaded bytes", `${formatBytes(uploadedBytes)} / ${formatBytes(uploadBytes)}`]);
      table.push(["Elapsed", formatElapsed(uploadStartedAt > 0 ? (Date.now() - uploadStartedAt) / 1000 : 0)]);
      table.push(["Speed", `${lastSpeedMbps.toFixed(2)} MB/s`]);
      if (serverStatus) {
        table.push(["Server phase", serverStatus.phase]);
        table.push(["Server received", `${serverStatus.received}/${serverStatus.expected}`]);
        table.push(["Server pending", `${serverStatus.pending}`]);
        table.push(["Server deleted", `${serverStatus.deleted}`]);
      }
      console.log(table.toString());
    };

    socket.once("connect", () => {
      writeMessage(socket, { type: "hello", project: path.basename(options.sourceDir) });
      writeMessage(socket, { type: "manifest", files: manifest });
      console.log(chalk.cyan(`Connected to ${options.host}:${options.port}`));
    });

    bindMessageReader(socket, async (msg: WireMessage) => {
      try {
        if (msg.type === "need") {
          uploadFiles = msg.files.length;
          uploadedFiles = 0;
          uploadBytes = msg.files.reduce((sum, relPath) => sum + (byPath.get(relPath)?.size ?? 0), 0);
          uploadedBytes = 0;
          uploadStartedAt = Date.now();
          lastSpeedMbps = 0;

          progressBar = new cliProgress.SingleBar(
            {
              format:
                `${chalk.cyan("Upload")} [{bar}] {pct}% | {sent}/{size} | {files}/{fileTotal} files | {speed} MB/s | {elapsed}`,
              hideCursor: true,
              clearOnComplete: false,
              barCompleteChar: "#",
              barIncompleteChar: "-"
            },
            cliProgress.Presets.shades_classic
          );

          const initialPct = uploadBytes === 0 ? "100.00" : "0.00";
          progressBar.start(Math.max(uploadBytes, 1), Math.min(uploadedBytes, Math.max(uploadBytes, 1)), {
            pct: initialPct,
            sent: formatBytes(0),
            size: formatBytes(uploadBytes),
            files: uploadedFiles,
            fileTotal: uploadFiles,
            speed: "0.00",
            elapsed: "0:00"
          });

          console.log(chalk.cyan(`Receiver requested ${uploadFiles} file(s), ${formatBytes(uploadBytes)} total`));

          for (const relPath of msg.files) {
            const info = byPath.get(relPath);
            if (!info) continue;

            const abs = path.join(options.sourceDir, relPath);
            const data = await fs.readFile(abs);
            await writeMessageAsync(socket, {
              type: "file",
              path: relPath,
              dataBase64: data.toString("base64"),
              sha1: info.sha1
            });

            uploadedFiles += 1;
            uploadedBytes += info.size;
            const elapsedSeconds = Math.max((Date.now() - uploadStartedAt) / 1000, 0.001);
            lastSpeedMbps = uploadedBytes / (1024 * 1024) / elapsedSeconds;
            const actualPct = uploadBytes === 0 ? 100 : (uploadedBytes / uploadBytes) * 100;
            const safePct = uploadedBytes < uploadBytes ? Math.min(actualPct, 99.99) : 100;
            progressBar.update(Math.min(uploadedBytes, Math.max(uploadBytes, 1)), {
              pct: safePct.toFixed(2),
              sent: formatBytes(uploadedBytes),
              size: formatBytes(uploadBytes),
              files: uploadedFiles,
              fileTotal: uploadFiles,
              speed: lastSpeedMbps.toFixed(2),
              elapsed: formatElapsed(elapsedSeconds)
            });
          }

          const finalElapsedSeconds = Math.max((Date.now() - uploadStartedAt) / 1000, 0.001);
          lastSpeedMbps = uploadedBytes / (1024 * 1024) / finalElapsedSeconds;

          progressBar.update(Math.max(uploadBytes, 1), {
            pct: "100.00",
            sent: formatBytes(uploadedBytes),
            size: formatBytes(uploadBytes),
            files: uploadedFiles,
            fileTotal: uploadFiles,
            speed: lastSpeedMbps.toFixed(2),
            elapsed: formatElapsed(finalElapsedSeconds)
          });
          progressBar.stop();
          progressBar = undefined;

          writeMessage(socket, { type: "done" });
          return;
        }

        if (msg.type === "status") {
          serverStatus = msg;
          console.log(
            chalk.gray(
              `Server status: phase=${msg.phase} received=${msg.received}/${msg.expected} pending=${msg.pending} deleted=${msg.deleted}`
            )
          );
          return;
        }

        if (msg.type === "result") {
          if (progressBar) {
            progressBar.stop();
            progressBar = undefined;
          }

          console.log(chalk.green(`Sync result: uploaded=${msg.received} deleted=${msg.deleted}`));
          if (msg.message) {
            console.log(chalk.green(msg.message));
          }
          renderStatusTable();
          finished = true;
          socket.end();
          resolve();
          return;
        }

        if (msg.type === "error") {
          if (progressBar) {
            progressBar.stop();
            progressBar = undefined;
          }
          reject(new Error(msg.message));
          socket.end();
        }
      } catch (error) {
        if (progressBar) {
          progressBar.stop();
          progressBar = undefined;
        }
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
