// Runs as part of `build`, not as a prepack hook: `pnpm pack` and `pnpm publish`
// skip prepack entirely, so a hook would ship a package with no skills in it.
import { chmodSync, cpSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(packageRoot, "dist", "index.js");
const bundled = join(packageRoot, "skills");
const source = resolve(packageRoot, "..", "..", "skills");

// bin/ entries need the exec bit or an npm install cannot run the server.
chmodSync(entry, 0o755);

// The canonical skills live at the repository root so they are usable without
// MCP. Copy them in so `files` can ship them, replacing any stale copy.
rmSync(bundled, { recursive: true, force: true });
cpSync(source, bundled, { recursive: true });
