import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ensureSettings, loadSettings, saveSettings } from "./settings.js";
import { startReceiver, pushToReceiver } from "./sync.js";

function parseNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeFilterInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  const unquoted = trimmed.replace(/^['\"]+|['\"]+$/g, "");
  return unquoted.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function parseHostPortInput(raw: string): { host: string; port: number } | undefined {
  const inputValue = raw.trim();
  if (!inputValue) return undefined;

  const separator = inputValue.lastIndexOf(":");
  if (separator <= 0) return undefined;

  const host = inputValue.slice(0, separator).trim();
  const portRaw = inputValue.slice(separator + 1).trim();
  const port = Number(portRaw);

  if (!host || !Number.isInteger(port) || port <= 0) {
    return undefined;
  }

  return { host, port };
}

async function addFilter(rawPath: string): Promise<void> {
  const targetPath = normalizeFilterInput(rawPath);
  if (!targetPath) {
    console.log("Path is empty");
    return;
  }

  const settings = await loadSettings();
  if (!settings.filters.includes(targetPath)) {
    settings.filters.push(targetPath);
    await saveSettings(settings);
    console.log(`Added filter: ${targetPath}`);
  } else {
    console.log(`Already exists: ${targetPath}`);
  }
}

async function removeFilter(rawPath: string): Promise<void> {
  const targetPath = normalizeFilterInput(rawPath);
  if (!targetPath) {
    console.log("Path is empty");
    return;
  }

  const settings = await loadSettings();
  const nextFilters = settings.filters.filter((x: string) => x !== targetPath);
  if (nextFilters.length === settings.filters.length) {
    console.log(`Not found: ${targetPath}`);
    return;
  }

  settings.filters = nextFilters;
  await saveSettings(settings);
  console.log(`Removed filter: ${targetPath}`);
}

async function promptMenu(): Promise<"listen" | "connect" | "settings"> {
  const rl = readline.createInterface({ input, output });
  try {
    console.log("Select mode:");
    console.log("1) listen  (open port and receive)");
    console.log("2) connect (send diff to receiver)");
    console.log("3) settings (edit filters/server)");

    const answer = (await rl.question("> ")).trim();
    if (answer === "1") return "listen";
    if (answer === "2") return "connect";
    return "settings";
  } finally {
    rl.close();
  }
}

async function runSettingsMenu(): Promise<void> {
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      const settings = await loadSettings();
      console.log("Settings Menu:");
      console.log("1) filter list");
      console.log("2) filter add");
      console.log("3) filter remove");
      console.log("4) server show");
      console.log("5) server set");
      console.log("6) server clear");
      console.log("0) exit");

      const line = (await rl.question("> ")).trim();
      const firstSpace = line.indexOf(" ");
      const choice = firstSpace >= 0 ? line.slice(0, firstSpace) : line;
      const inlinePath = firstSpace >= 0 ? line.slice(firstSpace + 1).trim() : "";

      if (choice === "0") {
        return;
      }

      if (choice === "1") {
        if (settings.filters.length === 0) {
          console.log("No filters configured");
        } else {
          for (const filter of settings.filters) {
            console.log(filter);
          }
        }
        continue;
      }

      if (choice === "2") {
        const rawPath = inlinePath || (await rl.question("Path to exclude: ")).trim();
        await addFilter(rawPath);
        continue;
      }

      if (choice === "3") {
        const rawPath = inlinePath || (await rl.question("Path to include again: ")).trim();
        await removeFilter(rawPath);
        continue;
      }

      if (choice === "4") {
        if (!settings.lastTarget) {
          console.log("No default server configured");
        } else {
          console.log(`${settings.lastTarget.host}:${settings.lastTarget.port}`);
        }
        continue;
      }

      if (choice === "5") {
        const rawServer = inlinePath || (await rl.question("Server (host:port): ")).trim();
        const parsed = parseHostPortInput(rawServer);
        if (!parsed) {
          console.log("Invalid format. Use host:port (e.g. 100.94.26.8:47321)");
          continue;
        }

        settings.lastTarget = parsed;
        await saveSettings(settings);
        console.log(`Default server set: ${parsed.host}:${parsed.port}`);
        continue;
      }

      if (choice === "6") {
        if (!settings.lastTarget) {
          console.log("No default server configured");
          continue;
        }

        delete settings.lastTarget;
        await saveSettings(settings);
        console.log("Default server cleared");
        continue;
      }

      console.log("Invalid selection");
    }
  } finally {
    rl.close();
  }
}

export async function runCli(argv: string[]): Promise<void> {
  await ensureSettings();
  await loadSettings();

  const [command, ...args] = argv;
  const cmd = command ?? (await promptMenu());

  if (cmd === "listen") {
    const settings = await loadSettings();
    const port = parseNumber(args[0] ?? "47321", 47321);
    const targetDir = path.resolve(args[1] ?? process.cwd());
    await startReceiver(port, targetDir, settings.filters);
    return;
  }

  if (cmd === "connect") {
    const settings = await loadSettings();

    let host = args[0];
    let port = args[1] ? parseNumber(args[1], 47321) : undefined;

    const saveIndex = args.indexOf("--save");
    const profileIndex = args.indexOf("--profile");
    const sourceIndex = args.indexOf("--source");

    if (profileIndex >= 0 && args[profileIndex + 1]) {
      const profile = settings.profiles[args[profileIndex + 1]];
      if (!profile) {
        throw new Error(`Profile not found: ${args[profileIndex + 1]}`);
      }
      host = profile.host;
      port = profile.port;
    }

    if ((!host || !port) && settings.lastTarget) {
      host = host ?? settings.lastTarget.host;
      port = port ?? settings.lastTarget.port;
    }

    if (!host || !port) {
      throw new Error("connect requires host and port, or a saved --profile");
    }

    const sourceDir = path.resolve(sourceIndex >= 0 ? args[sourceIndex + 1] ?? "." : ".");

    await pushToReceiver({
      host,
      port,
      sourceDir
    });

    settings.lastTarget = { host, port };

    if (saveIndex >= 0 && args[saveIndex + 1]) {
      settings.profiles[args[saveIndex + 1]] = { host, port };
      console.log(`Saved profile: ${args[saveIndex + 1]}`);
    }

    await saveSettings(settings);
    return;
  }

  if (cmd === "filter") {
    const action = args[0];
    const targetPath = normalizeFilterInput(args.slice(1).join(" "));
    const settings = await loadSettings();

    if (action === "put" && targetPath) {
      if (!settings.filters.includes(targetPath)) {
        settings.filters.push(targetPath);
      }
      await saveSettings(settings);
      console.log(`Added filter: ${targetPath}`);
      return;
    }

    if (action === "remove" && targetPath) {
      settings.filters = settings.filters.filter((x: string) => x !== targetPath);
      await saveSettings(settings);
      console.log(`Removed filter: ${targetPath}`);
      return;
    }

    if (action === "list") {
      if (settings.filters.length === 0) {
        console.log("No filters configured");
      } else {
        for (const filter of settings.filters) {
          console.log(filter);
        }
      }
      return;
    }

    throw new Error("Usage: filter put <path> | filter remove <path> | filter list");
  }

  if (cmd === "profiles") {
    const settings = await loadSettings();
    const names = Object.keys(settings.profiles);
    if (names.length === 0) {
      console.log("No profiles saved");
      return;
    }

    for (const name of names) {
      const profile = settings.profiles[name];
      console.log(`${name}: ${profile.host}:${profile.port}`);
    }
    return;
  }

  if (cmd === "settings") {
    await runSettingsMenu();
    return;
  }

  console.log("Commands:");
  console.log("  listen [port] [targetDir]");
  console.log("  connect <host> <port> [--source <path>] [--save <profileName>]");
  console.log("  connect --profile <profileName> [--source <path>]");
  console.log("  settings");
  console.log("  filter put <path>");
  console.log("  filter remove <path>");
  console.log("  filter list");
  console.log("  profiles");
}
