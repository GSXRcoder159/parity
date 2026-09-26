// A stand-in for `docker` in tests: records each argv, and runs `node --version` or the container's score-twin on the
// host with the -v mounts mapped back to host paths (docker itself is not needed; test/align-gate.test.ts has a real run).
import { execFileSync } from "node:child_process";

export function fakeDocker(calls: string[][]) {
  return (args: string[]): string => {
    calls.push(args);
    const mounts = new Map<string, string>();
    for (let i = 0; i < args.length; i++) if (args[i] === "-v") {
      const [host, box] = args[i + 1]!.split(":");
      mounts.set(box!, host!);
    }
    const node = args.indexOf("node");
    const cmd = args.slice(node + 1).map((a) => [...mounts].reduce((s, [box, host]) => (s.startsWith(box) ? host + s.slice(box.length) : s), a));
    if (cmd[0] === "--version") return process.version;
    const cwd = mounts.get(args[args.indexOf("-w") + 1]!)!;
    return execFileSync(process.execPath, cmd, { cwd, env: { PATH: process.env.PATH }, encoding: "utf8", maxBuffer: 1 << 28 });
  };
}
