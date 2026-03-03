import net from "node:net";
import type { WireMessage } from "./types.js";

export function writeMessage(socket: net.Socket, msg: WireMessage): void {
  socket.write(`${JSON.stringify(msg)}\n`);
}

export function bindMessageReader(socket: net.Socket, onMessage: (msg: WireMessage) => void | Promise<void>): void {
  let buffer = "";
  const queue: WireMessage[] = [];
  let processing = false;

  const processQueue = async (): Promise<void> => {
    if (processing) return;
    processing = true;

    while (queue.length > 0) {
      const msg = queue.shift();
      if (!msg) continue;
      await onMessage(msg);
    }

    processing = false;
  };

  const pushMessage = (msg: WireMessage): void => {
    queue.push(msg);
    void processQueue();
  };

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");

    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx < 0) break;

      const raw = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!raw) continue;

      try {
        pushMessage(JSON.parse(raw) as WireMessage);
      } catch {
        pushMessage({ type: "error", message: "Invalid JSON frame" });
      }
    }
  });
}
