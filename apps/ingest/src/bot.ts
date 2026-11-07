// Telegram bot (grammY). DMs only. Every message is redacted in the bot before it reaches the API.
//   /start <code>  link this Telegram account to a Proofwork persona
//   text           your own claim (type it or dictate it)                  -> telegram_text
//   voice / audio  transcribed on 0G Private Computer (whisper-large-v3)   -> telegram_text
//   forward        a client's message forwarded to the bot                  -> telegram_forward
//   .txt / .zip    a WhatsApp chat export                                   -> whatsapp_export
//   voice / audio  not transcribed (no speech-to-text provider): the bot asks for text instead
// Each item: pick a KRA -> AI draft (state drafted) -> "Sign & request co-sign" -> magic link to forward.
import { Bot, InlineKeyboard, type Context } from "grammy";
import type { IngestCore } from "./core.ts";

const MAX_DOC_BYTES = 20 * 1024 * 1024; // Telegram bot download limit

function kraKeyboard(pendingId: string, kras: Array<{ kra_id: string; label: string }>) {
  const kb = new InlineKeyboard();
  for (const k of kras) kb.text(k.label.slice(0, 60), `f:${pendingId}:${k.kra_id}`.slice(0, 64)).row();
  return kb.text("Discard", `x:${pendingId}`);
}

function describeOrigin(o: any): string {
  const when = o?.date ? new Date(o.date * 1000).toISOString().slice(0, 10) : "unknown date";
  const kind = o?.type === "channel" || o?.type === "chat" ? "a chat" : "a contact";
  return `Forwarded message from ${kind}, originally sent ${when}:`;
}

export function buildBot(token: string, core: IngestCore, log: (m: string) => void = console.log) {
  const bot = new Bot(token);
  const fail = (ctx: Context, e: unknown) => ctx.reply(`⚠️ ${(e as Error).message}`).catch(() => {});

  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== "private") return; // ignore groups and channels
    await next();
  });

  bot.command("start", async (ctx) => {
    const code = ctx.match?.trim();
    if (!code) {
      return ctx.reply("Hi! I file work evidence into Proofwork. Open the link code your manager sent you to connect your account.");
    }
    try {
      const { displayName } = await core.link(ctx.from!.id, code);
      await ctx.reply(`Linked as ${displayName}. Send me what you did (type it, or send a voice note), forward a client's message, or send a WhatsApp chat export (.txt or .zip).`);
    } catch (e) {
      await fail(ctx, e);
    }
  });

  bot.command("kras", async (ctx) => {
    try {
      const kras = await core.kras(ctx.from!.id);
      await ctx.reply("KRAs you can file co-signed claims against:\n" + kras.map((k) => `• ${k.label}`).join("\n"));
    } catch (e) {
      await fail(ctx, e);
    }
  });

  bot.command("help", (ctx) =>
    ctx.reply("Send text, forward a message, or upload a WhatsApp export. I redact phone numbers, emails, UPI IDs, card, Aadhaar and PAN numbers before anything leaves this chat. Claims stay Pending until your co-signer signs."),
  );

  const offer = async (ctx: Context, source: "telegram_text" | "telegram_forward", text: string) => {
    try {
      const { pending, kras } = await core.prepare(ctx.from!.id, source, text);
      await ctx.reply(`Redacted text:\n\n${pending.text.slice(0, 800)}\n\nWhich KRA is this for?`, { reply_markup: kraKeyboard(pending.id, kras) });
    } catch (e) {
      await fail(ctx, e);
    }
  };

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    const fwd = ctx.message.forward_origin;
    if (fwd) return offer(ctx, "telegram_forward", `${describeOrigin(fwd)}\n${ctx.message.text}`);
    return offer(ctx, "telegram_text", ctx.message.text);
  });

  bot.on(["message:voice", "message:audio"], async (ctx) => {
    const media = ctx.message.voice ?? ctx.message.audio;
    if (!media) return;
    if ((media.file_size ?? 0) > 2 * 1024 * 1024) return ctx.reply("That recording is over 2 MB. Please keep voice notes under about 2 minutes.");
    try {
      const file = await ctx.getFile();
      const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const mime = media.mime_type ?? "audio/ogg";
      const { text, requestId } = await core.transcribe(ctx.from!.id, bytes, mime);
      if (!text.trim()) return ctx.reply("I couldn't hear any speech in that. Try again, or type it.");
      await ctx.reply(`Transcribed privately on 0G (request ${requestId.split(",")[0].slice(0, 12)}…).`);
      return offer(ctx, "telegram_text", text);
    } catch (e) {
      await fail(ctx, e);
    }
  });

  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    const name = doc.file_name ?? "export.txt";
    if (!/\.(txt|zip)$/i.test(name)) return ctx.reply("Send a WhatsApp export as .txt or .zip.");
    if ((doc.file_size ?? 0) > MAX_DOC_BYTES) return ctx.reply("That file is over Telegram's 20 MB bot limit.");
    try {
      const file = await ctx.getFile();
      const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const r = await core.prepareWhatsApp(ctx.from!.id, name, bytes);
      await ctx.reply(`Parsed ${r.totalMessages} messages in ${r.totalChunks} day-chunks. Names are replaced with Person 1, Person 2… Filing the ${r.items.length} most recent:`);
      for (const it of r.items) {
        await ctx.reply(`${it.day} (${it.count} messages):\n\n${it.pending.text.slice(0, 600)}\n\nWhich KRA?`, { reply_markup: kraKeyboard(it.pending.id, it.kras) });
      }
    } catch (e) {
      await fail(ctx, e);
    }
  });

  bot.callbackQuery(/^x:(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Discarded");
    await ctx.editMessageReplyMarkup().catch(() => {});
  });

  bot.callbackQuery(/^f:(\w+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Drafting…");
    try {
      const claim = await core.file(ctx.from.id, ctx.match[1], ctx.match[2]);
      await ctx.editMessageReplyMarkup().catch(() => {});
      const flags = claim.ai_flags?.length ? `\n⚠️ AI flags: ${claim.ai_flags.join(", ")}` : "";
      await ctx.reply(
        `Draft claim ${claim.claim_id} (Pending until co-signed)\n• ${claim.body.summary}\n• on ${claim.body.occurred_on}, ${claim.body.duration_minutes} min, with ${claim.body.counterparty_label}${flags}`,
        { reply_markup: new InlineKeyboard().text("Sign & request co-sign", `s:${claim.claim_id}`) },
      );
    } catch (e) {
      await fail(ctx, e);
    }
  });

  bot.callbackQuery(/^s:(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Signing…");
    try {
      const r = await core.requestCosign(ctx.from.id, ctx.match[1]);
      await ctx.editMessageReplyMarkup().catch(() => {});
      if (r.cosignUrl) {
        await ctx.reply(`Signed and sent for co-sign. Forward this one-time link to your co-signer (expires ${r.expiresAt}):\n${r.cosignUrl}`);
      } else {
        await ctx.reply(`Open Proofwork to review and sign with your wallet:\n${r.reviewUrl}`);
      }
    } catch (e) {
      await fail(ctx, e);
    }
  });

  bot.catch((err) => log(`bot error: ${err.error instanceof Error ? err.error.message : String(err.error)}`));
  return bot;
}
