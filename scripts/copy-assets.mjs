import { chmod, cp, mkdir } from "node:fs/promises";

await mkdir("dist/public", { recursive: true });
await cp("public", "dist/public", { recursive: true, force: true });
await mkdir("dist/skills", { recursive: true });
await cp("skills", "dist/skills", { recursive: true, force: true });
await chmod("dist/src/cli.js", 0o755);
