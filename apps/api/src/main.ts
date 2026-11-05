import { loadEnvFile, parseConfig } from "./config.ts";
import { buildApp } from "./server.ts";

loadEnvFile();
const config = parseConfig();
const app = await buildApp(config);

const shutdown = async (sig: string) => {
  app.log.info({ sig }, "shutting down");
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: config.PORT, host: config.HOST });
app.log.info(
  { chain_mode: config.CHAIN_MODE, world_mode: config.WORLD_MODE, zerog_mode: config.ZEROG_MODE, auth_mode: config.AUTH_MODE },
  "proofwork api ready",
);
