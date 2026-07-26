import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = path.join(root, "node_modules", "node-datachannel");
const binary = path.join(packageDir, "build", "Release", "node_datachannel.node");

if (!existsSync(packageDir)) {
  console.warn("node-datachannel is not installed; skipping native ensure");
  process.exit(0);
}

if (existsSync(binary)) {
  console.log("node-datachannel native binary present");
  process.exit(0);
}

console.log("Installing node-datachannel N-API prebuild...");
const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["--yes", "prebuild-install", "-r", "napi"],
  { cwd: packageDir, stdio: "inherit", shell: true },
);

if (result.status !== 0 || !existsSync(binary)) {
  console.error(
    "Failed to install node-datachannel.node. WebTorrent WebRTC will not work.",
  );
  process.exit(1);
}

console.log("Installed", binary);
