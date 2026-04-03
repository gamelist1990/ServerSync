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

const HASH_COMPARE_CONCURRENCY = 4;
const DELETE_CONCURRENCY = 8;
const RECEIVE_WRITE_CONCURRENCY = 4;
const SEND_PRELOAD_CONCURRENCY = 4;

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

function formatPathForDisplay(relativePath: string, maxLength = 56): string {
  const normalized = relativePath.replaceAll("\\", "/");
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const keep = Math.max(8, Math.floor((maxLength - 3) / 2));
  return `${normalized.slice(0, keep)}...${normalized.slice(-(maxLength - keep - 3))}`;
}

function logBarMessage(bar: { log?: (message: string) => void } | undefined, message: string): void {
  if (bar && typeof bar.log === "function") {
    bar.log(message);
    return;
  }

  console.log(message);
}

function isPathWithinRoot(rootDir: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(rootDir), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolvePathWithinRoot(rootDir: string, relativePath: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedPath = path.resolve(rootDir, relativePath);

  if (!isPathWithinRoot(resolvedRoot, resolvedPath)) {
    throw new Error(`Refusing path outside root: ${relativePath}`);
  }

  return resolvedPath;
}

async function removeEmptyParentDirs(rootDir: string, filePath: string): Promise<void> {
  const resolvedRoot = path.resolve(rootDir);
  let currentDir = path.dirname(path.resolve(filePath));

  while (isPathWithinRoot(resolvedRoot, currentDir) && currentDir !== resolvedRoot) {
    const entries = await fs.readdir(currentDir);
    if (entries.length > 0) {
      return;
    }

    await fs.rmdir(currentDir);
    currentDir = path.dirname(currentDir);
  }
}

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

async function forEachConcurrent<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  await mapConcurrent(items, concurrency, async (item, index) => {
    await worker(item, index);
    return undefined;
  });
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

  const startupTable = new Table({ head: [chalk.cyan("Receiver"), chalk.cyan("Value")] });
  startupTable.push(["Port", `${port}`]);
  startupTable.push(["Target dir", targetDir]);
  startupTable.push(["Host", os.hostname()]);
  startupTable.push(["Filters", filters.length === 0 ? "(none)" : `${filters.length} item(s)`]);
  console.log(startupTable.toString());

  const server = net.createServer((socket: any) => {
    socket.setNoDelay(true);
    const remote = `${socket.remoteAddress ?? "unknown"}:${socket.remotePort ?? "?"}`;
    let manifest: FileManifestItem[] = [];
    let manifestByPath = new Map<string, FileManifestItem>();
    let expectedFileCount = 0;
    let needed = new Set<string>();
    let expectedBytes = 0;
    let receivedBytes = 0;
    let startedAt = 0;
    let deletedCount = 0;
    let writtenCount = 0;
    let receiveBar: any;
    const pendingReceiveWrites = new Set<Promise<void>>();

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
          manifestByPath = new Map(manifest.map((item) => [item.path, item]));
          const filteredManifest = manifest.filter((f) => !shouldSkip(f.path, filters, targetDir));
          const expected = new Set(filteredManifest.map((f) => f.path));
          const destinationFiles = existsSync(targetDir) ? await listDestinationFiles(targetDir, filters) : [];

          const deleteList = destinationFiles.filter((p) => !expected.has(p));

          const needFlags = await mapConcurrent(filteredManifest, HASH_COMPARE_CONCURRENCY, async (file) => {
            const absPath = path.join(targetDir, file.path);
            if (!existsSync(absPath)) {
              return true;
            }

            const currentStat = await fs.stat(absPath);
            if (currentStat.mtimeMs === file.mtimeMs && currentStat.size === file.size) {
              return false;
            }

            const currentHash = await sha1File(absPath);
            return currentHash !== file.sha1;
          });

          const needList = filteredManifest.filter((_, index) => needFlags[index]).map((file) => file.path);

          needed = new Set(needList);
          expectedFileCount = needList.length;
          expectedBytes = filteredManifest
            .filter((item) => needed.has(item.path))
            .reduce((sum, item) => sum + item.size, 0);
          receivedBytes = 0;
          startedAt = Date.now();

          // ── ログはバー開始前にまとめて出す ──
          console.log(
            chalk.cyan(
              `[receiver] scan  manifest=${manifest.length}  eligible=${filteredManifest.length}  need=${needList.length}  delete=${deleteList.length}`
            )
          );

          await forEachConcurrent(deleteList, DELETE_CONCURRENCY, async (rel) => {
            const absToDelete = resolvePathWithinRoot(targetDir, rel);
            await fs.rm(absToDelete, { force: true });
            await removeEmptyParentDirs(targetDir, absToDelete);
            deletedCount += 1;
            console.log(chalk.yellow(`[receiver] deleted ${rel}`));
          });

          receiveBar = new cliProgress.SingleBar(
            {
              format:
                `${chalk.green("Receive")} [{bar}] {pct}% | {sent}/{size} | {files}/{fileTotal} | {speed} MB/s | {elapsed} | {file}`,
              barsize: 28,
              hideCursor: true,
              clearOnComplete: false,
              barCompleteChar: "#",
              barIncompleteChar: "-"
            },
            cliProgress.Presets.shades_classic
          );

          receiveBar.start(Math.max(expectedBytes, 1), 0, {
            pct: expectedBytes === 0 ? "100.00" : "0.00",
            sent: formatBytes(0),
            size: formatBytes(expectedBytes),
            files: 0,
            fileTotal: expectedFileCount,
            speed: "0.00",
            elapsed: "0:00",
            file: "-"
          });

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

          if (receiveBar) {
            receiveBar.update(Math.min(receivedBytes, Math.max(expectedBytes, 1)), {
              pct: expectedBytes === 0 ? "100.00" : ((receivedBytes / expectedBytes) * 100).toFixed(2),
              sent: formatBytes(receivedBytes),
              size: formatBytes(expectedBytes),
              files: writtenCount,
              fileTotal: expectedFileCount,
              speed: "0.00",
              elapsed: formatElapsed(Math.max((Date.now() - startedAt) / 1000, 0)),
              file: formatPathForDisplay(msg.path)
            });
          }
          const receiveTask = (async () => {
            const absPath = resolvePathWithinRoot(targetDir, msg.path);
            const data = Buffer.from(msg.dataBase64, "base64");
            const actualHash = sha1Buffer(data);
            if (actualHash !== msg.sha1) {
              throw new Error(`Hash mismatch: ${msg.path}`);
            }

            await fs.mkdir(path.dirname(absPath), { recursive: true });
            await fs.writeFile(absPath, data);
            writtenCount += 1;
            const fileSize = manifestByPath.get(msg.path)?.size ?? data.length;
            receivedBytes += fileSize;
            needed.delete(msg.path);

            if (receiveBar) {
              const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
              const speedMbps = receivedBytes / (1024 * 1024) / elapsedSeconds;
              const actualPct = expectedBytes === 0 ? 100 : (receivedBytes / expectedBytes) * 100;
              const safePct = receivedBytes < expectedBytes ? Math.min(actualPct, 99.99) : 100;

              receiveBar.update(Math.min(receivedBytes, Math.max(expectedBytes, 1)), {
                pct: safePct.toFixed(2),
                sent: formatBytes(receivedBytes),
                size: formatBytes(expectedBytes),
                files: writtenCount,
                fileTotal: expectedFileCount,
                speed: speedMbps.toFixed(2),
                elapsed: formatElapsed(elapsedSeconds),
                file: formatPathForDisplay(msg.path)
              });
            }
            logBarMessage(receiveBar, chalk.gray(`received ${msg.path}\n`));

            if (writtenCount % 50 === 0 || needed.size === 0) {
              sendStatus("receiving");
            }
          })().catch((error) => {
            writeMessage(socket, {
              type: "error",
              message: error instanceof Error ? error.message : `Receive failed: ${msg.path}`
            });
            socket.end();
            throw error;
          });

          pendingReceiveWrites.add(receiveTask);
          receiveTask.finally(() => {
            pendingReceiveWrites.delete(receiveTask);
          });

          if (pendingReceiveWrites.size >= RECEIVE_WRITE_CONCURRENCY) {
            await Promise.race(pendingReceiveWrites);
          }
          return;
        }

        if (msg.type === "done") {
          if (pendingReceiveWrites.size > 0) {
            await Promise.all(Array.from(pendingReceiveWrites));
          }
          sendStatus("finalizing");
          if (receiveBar) {
            const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
            const speedMbps = receivedBytes / (1024 * 1024) / elapsedSeconds;
            receiveBar.update(Math.max(expectedBytes, 1), {
              pct: "100.00",
              sent: formatBytes(receivedBytes),
              size: formatBytes(expectedBytes),
              files: writtenCount,
              fileTotal: expectedFileCount,
              speed: speedMbps.toFixed(2),
              elapsed: formatElapsed(elapsedSeconds),
              file: needed.size === 0 ? "-" : formatPathForDisplay("waiting...")
            });
            receiveBar.stop();
            receiveBar = undefined;
          }

          console.log(chalk.green(`[receiver] finalizing: received=${writtenCount} deleted=${deletedCount} pending=${needed.size}`));

          const resultTable = new Table({ head: [chalk.cyan("Receiver Result"), chalk.cyan("Value")] });
          resultTable.push(["Remote", remote]);
          resultTable.push(["Received files", `${writtenCount}/${expectedFileCount}`]);
          resultTable.push(["Received bytes", `${formatBytes(receivedBytes)} / ${formatBytes(expectedBytes)}`]);
          resultTable.push(["Deleted", `${deletedCount}`]);
          resultTable.push(["Pending", `${needed.size}`]);
          console.log(resultTable.toString());

          writeMessage(socket, {
            type: "result",
            received: writtenCount,
            deleted: deletedCount,
            message: needed.size === 0 ? "Sync completed" : `Missing files: ${needed.size}`
          });
          socket.end();
        }
      } catch (error) {
        if (receiveBar) {
          receiveBar.stop();
          receiveBar = undefined;
        }
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

  console.log(chalk.green("Receiver listening..."));
}

export async function pushToReceiver(options: {
  host: string;
  port: number;
  sourceDir: string;
  filters?: string[];
}): Promise<void> {
  const manifest = await buildManifest(options.sourceDir, options.filters ?? []);
  console.log(chalk.cyan(`Preparing sync: files=${manifest.length}`));

  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: options.host, port: options.port });
    socket.setNoDelay(true);
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

          // ── ログはバー開始前にまとめて出す ──
          console.log(chalk.cyan(`Uploading  ${uploadFiles} file(s)  ${formatBytes(uploadBytes)}`));

          progressBar = new cliProgress.SingleBar(
            {
              format:
                `${chalk.cyan("Upload")} [{bar}] {pct}% | {sent}/{size} | {files}/{fileTotal} | {speed} MB/s | {elapsed} | {file}`,
              barsize: 28,
              hideCursor: true,
              clearOnComplete: false,
              barCompleteChar: "#",
              barIncompleteChar: "-"
            },
            cliProgress.Presets.shades_classic
          );

          const initialPct = uploadBytes === 0 ? "100.00" : "0.00";
          progressBar.start(Math.max(uploadBytes, 1), 0, {
            pct: initialPct,
            sent: formatBytes(0),
            size: formatBytes(uploadBytes),
            files: uploadedFiles,
            fileTotal: uploadFiles,
            speed: "0.00",
            elapsed: "0:00",
            file: "-"
          });

          const preloadFile = async (relPath: string) => {
            const info = byPath.get(relPath);
            if (!info) {
              return undefined;
            }

            const abs = resolvePathWithinRoot(options.sourceDir, relPath);
            const data = await fs.readFile(abs);
            return {
              relPath,
              info,
              dataBase64: data.toString("base64")
            };
          };

          const preloadQueue = new Map<number, Promise<Awaited<ReturnType<typeof preloadFile>>>>();
          const queuePreload = (index: number): void => {
            if (index >= msg.files.length || preloadQueue.has(index)) {
              return;
            }
            preloadQueue.set(index, preloadFile(msg.files[index]));
          };

          for (let index = 0; index < Math.min(SEND_PRELOAD_CONCURRENCY, msg.files.length); index += 1) {
            queuePreload(index);
          }

          for (let index = 0; index < msg.files.length; index += 1) {
            queuePreload(index + SEND_PRELOAD_CONCURRENCY);
            const prepared = await preloadQueue.get(index);
            preloadQueue.delete(index);
            if (!prepared) {
              continue;
            }

            progressBar.update(Math.min(uploadedBytes, Math.max(uploadBytes, 1)), {
              pct: uploadBytes === 0 ? "100.00" : ((uploadedBytes / uploadBytes) * 100).toFixed(2),
              sent: formatBytes(uploadedBytes),
              size: formatBytes(uploadBytes),
              files: uploadedFiles,
              fileTotal: uploadFiles,
              speed: lastSpeedMbps.toFixed(2),
              elapsed: formatElapsed(Math.max((Date.now() - uploadStartedAt) / 1000, 0)),
              file: formatPathForDisplay(prepared.relPath)
            });

            await writeMessageAsync(socket, {
              type: "file",
              path: prepared.relPath,
              dataBase64: prepared.dataBase64,
              sha1: prepared.info.sha1
            });

            uploadedFiles += 1;
            uploadedBytes += prepared.info.size;
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
              elapsed: formatElapsed(elapsedSeconds),
              file: formatPathForDisplay(prepared.relPath)
            });
            logBarMessage(progressBar, chalk.gray(`sent ${prepared.relPath}\n`));
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
            elapsed: formatElapsed(finalElapsedSeconds),
            file: "-"
          });
          progressBar.stop();
          progressBar = undefined;

          writeMessage(socket, { type: "done" });
          return;
        }

        if (msg.type === "status") {
          serverStatus = msg;
          if (progressBar) {
            logBarMessage(
              progressBar,
              chalk.gray(`Server: phase=${msg.phase}  recv=${msg.received}/${msg.expected}  pending=${msg.pending}\n`)
            );
          }
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
