// pnpm --filter @proofwork/ingest link:code <persona_id> [hours=72]
// Prints a one-tap Telegram deep link that binds whoever opens it to that demo persona.
import { loadEnvFile, parseConfig } from "../src/config.ts";
import { makeLinkCode } from "../src/links.ts";

loadEnvFile();
const c = parseConfig();
const [personaId, hours = "72"] = process.argv.slice(2);
if (!personaId) {
  console.error("usage: link:code <persona_id> [hours]   e.g. link:code p_dev_a");
  process.exit(1);
}
const code = makeLinkCode(c.LINK_SECRET, personaId, Math.floor(Date.now() / 1000) + Number(hours) * 3600);
console.log(c.TELEGRAM_BOT_USERNAME ? `https://t.me/${c.TELEGRAM_BOT_USERNAME}?start=${code}` : `/start ${code}   (set TELEGRAM_BOT_USERNAME for a t.me link)`);
