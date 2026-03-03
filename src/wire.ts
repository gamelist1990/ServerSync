import net from "node:net";
import type { WireMessage } from "./types.js";

export function writeMessage(socket: net.Socket, msg: WireMessage): void {
  socket.write(`${JSON.stringify(msg)}\n`);
}

export function bindMessageReader(socket: net.Socket, onMessage: (msg: WireMessage) => void): void {
  let buffer = "";

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");

    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx < 0) break;

      const raw = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!raw) continue;

      try {
        onMessage(JSON.parse(raw) as WireMessage);
      } catch {
        onMessage({ type: "error", message: "Invalid JSON frame" });
      }
    }
  });
}
