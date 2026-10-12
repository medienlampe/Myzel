import type { AddressInfo } from "node:net";
import type { Express } from "express";

/** Listen on an ephemeral loopback port; returns the base URL and a closer. */
export async function listen(app: Express): Promise<{ base: string; close: () => void }> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close(),
  };
}
