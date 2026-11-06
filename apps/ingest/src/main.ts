// pnpm --filter @proofwork/ingest dev : Telegram bot (long polling) + GitHub webhook server on INGEST_PORT.
import { ProofworkApi } from "./api.ts";
import { buildBot } from "./bot.ts";
import { loadEnvFile, parseConfig } from "./config.ts";
import { IngestCore } from "./core.ts";
import { parseLoginMap } from "./github.ts";
import { Bindings } from "./links.ts";
import { buildServer } from "./server.ts";

loadEnvFile();
const c = parseConfig();
const core = new IngestCore({
  api: new ProofworkApi(c.API_BASE_URL),
  linkSecret: c.LINK_SECRET,
  connectorKey: c.CONNECTOR_KEY,
  cosigner: { address: c.COSIGNER_ADDRESS, label: c.COSIGNER_LABEL },
  webBase: c.WEB_BASE_URL,
  bindings: new Bindings(c.BINDINGS_FILE),
  cycleId: c.INGEST_CYCLE_ID,
  github: c.GITHUB_WEBHOOK_SECRET ? { secret: c.GITHUB_WEBHOOK_SECRET, ctx: { cycleId: c.INGEST_CYCLE_ID ?? "cyc_2026h2", logins: parseLoginMap(c.GITHUB_LOGIN_MAP) } } : undefined,
});

buildServer(core).listen(c.INGEST_PORT, () =>
  console.log(`ingest: GitHub webhook on http://localhost:${c.INGEST_PORT}/webhooks/github${c.GITHUB_WEBHOOK_SECRET ? "" : " (disabled: GITHUB_WEBHOOK_SECRET not set)"}`),
);

if (c.TELEGRAM_BOT_TOKEN) {
  const bot = buildBot(c.TELEGRAM_BOT_TOKEN, core);
  bot.start({ onStart: (me) => console.log(`ingest: Telegram bot @${me.username} polling (API ${c.API_BASE_URL})`) });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => bot.stop());
} else {
  console.log("ingest: TELEGRAM_BOT_TOKEN not set, bot disabled");
}
