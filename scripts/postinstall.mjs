import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const isGlobal = process.env.npm_config_global === "true";
const isCi = Boolean(process.env.CI);
const disabled = process.env.OMNIX_GO_SKIP_AUTO_SERVICE === "1";

if (isGlobal && !isCi && !disabled) {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const cli = path.join(packageRoot, "dist", "src", "cli.js");
  const args = [cli, "service", "install", "--tunnel", "auto", "--no-open"];
  if (process.env.INIT_CWD) args.push("--workspace", process.env.INIT_CWD);
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.stderr.write(
      "OmniX Go was installed, but automatic user-service setup did not complete. Run `omnix-go service install` to retry.\n",
    );
  }
}
