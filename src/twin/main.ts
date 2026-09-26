// Twin entrypoint: `node src/twin/main.ts [--port 12111] [--host 127.0.0.1]` (port also from env PORT).
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";
import { createTwin } from "./server.ts";
import { API_VERSION } from "./store.ts";

/** How long requests in flight at SIGINT/SIGTERM get to finish before their connections are cut. */
const DRAIN_MS = 5000;

/** Serves the twin until SIGINT/SIGTERM, then resolves 0; bad flags print one line and resolve 2, a failed bind resolves 1. */
export async function main(argv: string[]): Promise<number> {
  let port: number;
  let host: string;
  try {
    const { values } = parseArgs({ args: argv, options: { port: { type: "string" }, host: { type: "string" } } });
    const raw = values.port ?? process.env.PORT ?? "12111";
    port = Number(raw);
    if (!/^\d+$/.test(raw) || port > 65535) throw new Error(`invalid port "${raw}"`);
    host = values.host ?? "127.0.0.1";
  } catch (e) {
    console.error(`parity twin: ${(e as Error).message}\nusage: node src/twin/main.ts [--port 12111] [--host 127.0.0.1]`);
    return 2;
  }

  let server: Server;
  try {
    server = await createTwin().listen(port, host);
  } catch (e) {
    console.error(`parity twin: ${(e as Error).message}`); // e.g. listen EADDRINUSE: address already in use 127.0.0.1:12111
    return 1;
  }
  console.log(`parity twin listening on http://${host}:${(server.address() as AddressInfo).port} (API ${API_VERSION})`);

  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop).off("SIGTERM", stop);
      // Stops accepting and closes idle keep-alive sockets; requests in flight finish (and close their socket).
      server.close(() => resolve());
      setTimeout(() => server.closeAllConnections(), DRAIN_MS).unref();
    };
    process.on("SIGINT", stop).on("SIGTERM", stop);
  });
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
