import { chmod, cp, mkdir } from "node:fs/promises";

await mkdir("dist/public", { recursive: true });
// The rendered story frames are runtime assets; the original promotional video is not.
await cp("public", "dist/public", {
  recursive: true,
  force: true,
  filter: (source) => !source.endsWith("Create_motion_graphic_for_OmniX_202608092029.mp4"),
});
await mkdir("dist/skills", { recursive: true });
await cp("skills", "dist/skills", { recursive: true, force: true });
await chmod("dist/src/cli.js", 0o755);
