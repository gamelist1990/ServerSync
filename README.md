# ServerSync

Diff-optimized server sync CLI built with Bun + TypeScript.

## What It Does

- `listen`: opens a TCP port and receives updates into a target directory.
- `connect`: sends only changed files to the receiver (hash-based diff).
- `settings`: interactive menu to edit filter entries.
- `filter put <path>`: excludes files/folders from sync.
- Saves config in `.ServerSync/settings.json`.
- Supports saved target profiles.

## Install

```bash
cd ServerSync
bun install
```

## Usage

Start receiver on release server:

```bash
bun run src/index.ts listen 47321 ./release-server
```

Send diff from debug server:

```bash
bun run src/index.ts connect 192.168.1.50 47321 --source ./debug-server --save release
```

Connect again using saved profile:

```bash
bun run src/index.ts connect --profile release --source ./debug-server
```

Manage filters:

```bash
bun run src/index.ts settings
bun run src/index.ts filter put world/playerdata
bun run src/index.ts filter put logs
bun run src/index.ts filter list
bun run src/index.ts filter remove logs
```

Show profiles:

```bash
bun run src/index.ts profiles
```

## Settings File

Path: `.ServerSync/settings.json`

```json
{
  "filters": ["world/playerdata", "logs"],
  "profiles": {
    "release": {
      "host": "192.168.1.50",
      "port": 47321
    }
  },
  "lastTarget": {
    "host": "192.168.1.50",
    "port": 47321
  }
}
```

## Notes

- Current transport uses JSON over TCP with base64 file payloads.
- The receiver mirrors source files: files missing from source are deleted on receiver.
- Add critical runtime data to filter list to avoid replacement/deletion.
