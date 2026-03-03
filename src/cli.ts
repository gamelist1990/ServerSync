import path from "node:path";
import chalk from "chalk";
import inquirer from "inquirer";
import Table from "cli-table3";
import { ensureSettings, loadSettings, saveSettings } from "./settings.js";
import { startReceiver, pushToReceiver } from "./sync.js";

type ModeChoice = "listen" | "connect" | "settings";
type SettingsAction =
  | "filter-list"
  | "filter-add"
  | "filter-remove"
  | "server-show"
  | "server-set"
  | "server-clear"
  | "exit";

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

function printFilters(filters: string[]): void {
  if (filters.length === 0) {
    console.log(chalk.yellow("No filters configured"));
    return;
  }

  const table = new Table({ head: [chalk.cyan("#"), chalk.cyan("Filter")], colWidths: [6, 90] });
  filters.forEach((filter, i) => {
    table.push([`${i + 1}`, filter]);
  });
  console.log(table.toString());
}

function printProfiles(profiles: Record<string, { host: string; port: number }>): void {
  const names = Object.keys(profiles);
  if (names.length === 0) {
    console.log(chalk.yellow("No profiles saved"));
    return;
  }

  const table = new Table({ head: [chalk.cyan("Name"), chalk.cyan("Target")] });
  names.forEach((name) => {
    const profile = profiles[name];
    table.push([name, `${profile.host}:${profile.port}`]);
  });
  console.log(table.toString());
}

async function addFilter(rawPath: string): Promise<void> {
  const targetPath = normalizeFilterInput(rawPath);
  if (!targetPath) {
    console.log(chalk.red("Path is empty"));
    return;
  }

  const settings = await loadSettings();
  if (!settings.filters.includes(targetPath)) {
    settings.filters.push(targetPath);
    await saveSettings(settings);
    console.log(chalk.green(`Added filter: ${targetPath}`));
  } else {
    console.log(chalk.yellow(`Already exists: ${targetPath}`));
  }
}

async function removeFilter(rawPath: string): Promise<void> {
  const targetPath = normalizeFilterInput(rawPath);
  if (!targetPath) {
    console.log(chalk.red("Path is empty"));
    return;
  }

  const settings = await loadSettings();
  const nextFilters = settings.filters.filter((x: string) => x !== targetPath);
  if (nextFilters.length === settings.filters.length) {
    console.log(chalk.yellow(`Not found: ${targetPath}`));
    return;
  }

  settings.filters = nextFilters;
  await saveSettings(settings);
  console.log(chalk.green(`Removed filter: ${targetPath}`));
}

async function promptMenu(): Promise<"listen" | "connect" | "settings"> {
  const answer = await inquirer.prompt<{ mode: ModeChoice | string }>([
    {
      type: "rawlist",
      name: "mode",
      message: "Select mode",
      choices: [
        { name: "listen  (open port and receive)", value: "listen" },
        { name: "connect (send diff to receiver)", value: "connect" },
        { name: "settings (edit filters/server)", value: "settings" }
      ]
    }
  ]);

  const normalized = String(answer.mode ?? "").trim().toLowerCase();
  if (normalized === "1" || normalized === "listen") return "listen";
  if (normalized === "2" || normalized === "connect") return "connect";
  if (normalized === "3" || normalized === "settings") return "settings";
  return "settings";
}

async function runSettingsMenu(): Promise<void> {
  let invalidCount = 0;

  while (true) {
    const settings = await loadSettings();

    const answer = await inquirer.prompt<{ action: SettingsAction | string }>([
      {
        type: "rawlist",
        name: "action",
        message: "Settings Menu",
        choices: [
          { name: "filter list", value: "filter-list" },
          { name: "filter add", value: "filter-add" },
          { name: "filter remove", value: "filter-remove" },
          { name: "server show", value: "server-show" },
          { name: "server set", value: "server-set" },
          { name: "server clear", value: "server-clear" },
          { name: "exit", value: "exit" }
        ]
      }
    ]);

    const actionRaw = String(answer.action ?? "").trim().toLowerCase();
    const action: SettingsAction | undefined =
      actionRaw === "1" || actionRaw === "filter-list"
        ? "filter-list"
        : actionRaw === "2" || actionRaw === "filter-add"
          ? "filter-add"
          : actionRaw === "3" || actionRaw === "filter-remove"
            ? "filter-remove"
            : actionRaw === "4" || actionRaw === "server-show"
              ? "server-show"
              : actionRaw === "5" || actionRaw === "server-set"
                ? "server-set"
                : actionRaw === "6" || actionRaw === "server-clear"
                  ? "server-clear"
                  : actionRaw === "7" || actionRaw === "exit"
                    ? "exit"
                    : undefined;

    if (!action) {
      invalidCount += 1;
      console.log(chalk.yellow("Invalid selection"));
      if (invalidCount >= 3) {
        console.log(chalk.red("Too many invalid selections. Exiting settings menu."));
        return;
      }
      continue;
    }

    invalidCount = 0;

    if (action === "exit") {
      return;
    }

    if (action === "filter-list") {
      printFilters(settings.filters);
      continue;
    }

    if (action === "filter-add") {
      const inputAnswer = await inquirer.prompt<{ filterPath: string }>([
        { type: "input", name: "filterPath", message: "Path to exclude:" }
      ]);
      await addFilter(inputAnswer.filterPath);
      continue;
    }

    if (action === "filter-remove") {
      const inputAnswer = await inquirer.prompt<{ filterPath: string }>([
        { type: "input", name: "filterPath", message: "Path to include again:" }
      ]);
      await removeFilter(inputAnswer.filterPath);
      continue;
    }

    if (action === "server-show") {
      if (!settings.lastTarget) {
        console.log(chalk.yellow("No default server configured"));
      } else {
        console.log(chalk.green(`${settings.lastTarget.host}:${settings.lastTarget.port}`));
      }
      continue;
    }

    if (action === "server-set") {
      const inputAnswer = await inquirer.prompt<{ server: string }>([
        { type: "input", name: "server", message: "Server (host:port):" }
      ]);
      const parsed = parseHostPortInput(inputAnswer.server);
      if (!parsed) {
        console.log(chalk.red("Invalid format. Use host:port (e.g. 100.94.26.8:47321)"));
        continue;
      }

      settings.lastTarget = parsed;
      await saveSettings(settings);
      console.log(chalk.green(`Default server set: ${parsed.host}:${parsed.port}`));
      continue;
    }

    if (action === "server-clear") {
      if (!settings.lastTarget) {
        console.log(chalk.yellow("No default server configured"));
        continue;
      }

      delete settings.lastTarget;
      await saveSettings(settings);
      console.log(chalk.green("Default server cleared"));
      continue;
    }
  }
}

export async function runCli(argv: string[]): Promise<void> {
  await ensureSettings();
  await loadSettings();

  const [command, ...args] = argv;
  const selected = command ?? (await promptMenu());
  const cmdRaw = String(selected).trim().toLowerCase();
  const cmd: ModeChoice | string =
    cmdRaw === "1" ? "listen" : cmdRaw === "2" ? "connect" : cmdRaw === "3" ? "settings" : selected;

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
      sourceDir,
      filters: settings.filters
    });

    settings.lastTarget = { host, port };

    if (saveIndex >= 0 && args[saveIndex + 1]) {
      settings.profiles[args[saveIndex + 1]] = { host, port };
      console.log(chalk.green(`Saved profile: ${args[saveIndex + 1]}`));
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
      console.log(chalk.green(`Added filter: ${targetPath}`));
      return;
    }

    if (action === "remove" && targetPath) {
      settings.filters = settings.filters.filter((x: string) => x !== targetPath);
      await saveSettings(settings);
      console.log(chalk.green(`Removed filter: ${targetPath}`));
      return;
    }

    if (action === "list") {
      printFilters(settings.filters);
      return;
    }

    throw new Error("Usage: filter put <path> | filter remove <path> | filter list");
  }

  if (cmd === "profiles") {
    const settings = await loadSettings();
    printProfiles(settings.profiles);
    return;
  }

  if (cmd === "settings") {
    await runSettingsMenu();
    return;
  }

  console.log(chalk.cyan("Commands:"));
  console.log("  listen [port] [targetDir]");
  console.log("  connect <host> <port> [--source <path>] [--save <profileName>]");
  console.log("  connect --profile <profileName> [--source <path>]");
  console.log("  settings");
  console.log("  filter put <path>");
  console.log("  filter remove <path>");
  console.log("  filter list");
  console.log("  profiles");
}
