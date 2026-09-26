// `npm run build` (and prepack): the compiled package. Node will not strip types under node_modules, so `npx paritybench`
// runs dist/src/cli.js. tsc emits src/** and templates/** (imports rewritten .ts -> .js); every other file there (shapes,
// spec, catalogs, the vendored spec's LICENSE) is copied to the same relative place. `node scripts/build.ts [outDir]`.
import { spawnSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = resolve(process.argv[2] ?? join(root, "dist"));
rmSync(out, { recursive: true, force: true });
const tsc = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(root, "tsconfig.build.json"), "--outDir", out], { stdio: "inherit" });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
for (const dir of ["src", "templates"]) cpSync(join(root, dir), join(out, dir), { recursive: true, filter: (p) => !p.endsWith(".ts") });
