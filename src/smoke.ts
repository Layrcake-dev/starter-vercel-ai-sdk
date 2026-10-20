// Free setup check. Runs the agent's tools in dry-run mode against the live
// Layrcake API, with no model. Every call returns a plan and charges nothing.
import { randomUUID } from "node:crypto";
import type { ToolExecutionOptions } from "ai";
import { Layrcake } from "layrcake";
import { createLayrcakeTools } from "./tools.js";

const client = new Layrcake(); // reads LAYRCAKE_API_KEY
const { tools, summary } = createLayrcakeTools({ client, budget: Number(process.env.BUDGET ?? 100), dryRun: true, runId: randomUUID() });
const options = { toolCallId: "smoke", messages: [] } as unknown as ToolExecutionOptions<never>;
const sample = { email: "sample.person@example.com", first_name: "Sample" };

const me = await client.getMe();
console.log(`Key works for workspace "${me.result.workspace.name}". Balance: ${me.result.credits?.available ?? "unknown"} credits.`);
const plans = {
  find_leads: await tools.find_leads.execute({ audience: "Heads of sales at London software companies with 20 to 200 staff", titles: ["Head of Sales"], locations: ["London, United Kingdom"], industries: ["Software Development"], company_headcount: { min: 20, max: 200 }, limit: 10 }, options),
  enrich: await tools.enrich.execute({ full_name: "Sample Person", company_domain: "example.com" }, options),
  verify_email: await tools.verify_email.execute({ email: sample.email }, options),
  create_campaign: await tools.create_campaign.execute({ name: "Smoke test", leads: [sample], steps: [{ subject: "Hello", body: "Hi {{first_name}}" }] }, options),
};
for (const [name, plan] of Object.entries(plans)) {
  const p = plan as { would_cost_up_to?: string; would_exceed?: string[] };
  console.log(`${name}: would cost up to ${p.would_cost_up_to} credits${p.would_exceed?.length ? `, would trip: ${p.would_exceed.join(", ")}` : ""}`);
}
console.log(`\nCharged: ${summary().spent} credits. Your key and the Layrcake API work.`);
