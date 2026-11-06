// Probe: run the kra-agent 0G tool-calling planner's first two rounds and print what 0G returns.
import { loadEnvFile, parseConfig } from "../src/config.ts";
import { zeroGToolChat } from "../src/ai/inference.ts";
loadEnvFile();
const c = parseConfig(process.env);
const cfg = { baseUrl: c.ZEROG_BASE_URL, apiKey: c.ZEROG_API_KEY!, model: c.ZEROG_MODEL! };
const tools = ["git", "tickets", "crm", "hris", "worklog"].map((n) => ({ type: "function", function: { name: n, description: n + " system", parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } } }));
const messages: any[] = [
  { role: "system", content: "You are kra-agent. Call the tools that hold work evidence for this employee. When done, reply with one sentence." },
  { role: "user", content: "Collect evidence for Ben Carter, department software, level ic." },
];
try {
  const r1 = await zeroGToolChat(cfg, messages, tools);
  console.log("round1", r1.request_id, JSON.stringify(r1.message).slice(0, 400));
  const calls = r1.message.tool_calls ?? [];
  messages.push({ role: "assistant", content: r1.message.content ?? "", tool_calls: calls });
  for (const k of calls) messages.push({ role: "tool", tool_call_id: k.id, content: JSON.stringify({ ran: true }) });
  const r2 = await zeroGToolChat(cfg, messages, tools);
  console.log("round2", r2.request_id, JSON.stringify(r2.message).slice(0, 300));
} catch (e) {
  console.log("ERR", (e as Error).message);
}
process.exit(0);
