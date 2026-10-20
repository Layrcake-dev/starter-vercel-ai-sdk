import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, hasToolCall, isStepCount } from "ai";
import { Layrcake } from "layrcake";
import { DEFAULT_BRIEF, instructions } from "./instructions.js";
import { createLayrcakeTools } from "./tools.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { "dry-run": { type: "boolean", default: false } } });
const dryRun = values["dry-run"];
const brief = positionals.join(" ") || DEFAULT_BRIEF;
const budget = Number(process.env.BUDGET ?? 100);
if (!process.env.ANTHROPIC_API_KEY) throw new Error("Set ANTHROPIC_API_KEY. Get one at https://platform.claude.com");
if (!(budget > 0)) throw new Error("BUDGET must be a positive number of credits.");

const client = new Layrcake(); // reads LAYRCAKE_API_KEY
const { tools, summary } = createLayrcakeTools({ client, budget, dryRun, runId: randomUUID() });
console.log(`${dryRun ? "Dry run, nothing is charged" : "Live run"}. Budget: ${budget} credits.\nBrief: ${brief}\n`);

const result = await generateText({
  model: anthropic(process.env.MODEL ?? "claude-sonnet-5-5"),
  instructions: instructions({ budget, dryRun }),
  prompt: brief,
  tools,
  toolCallConcurrency: 1, // one Layrcake call at a time keeps the budget exact
  stopWhen: [hasToolCall("launch_campaign"), isStepCount(40)], // stop at the approval link
  onToolExecutionStart: ({ toolCall }) => console.log(`-> ${toolCall.toolName}`),
});

if (result.text) console.log(`\n${result.text}`);
const run = summary();
console.log(`\nFound ${run.found} people. Kept ${run.kept} verified emails (${run.catchAll} catch-all).`);
console.log(`Layrcake credits spent: ${run.spent} of ${budget}.`);
if (run.approvalUrl) console.log(`Nothing has been sent. A person approves or declines here: ${run.approvalUrl}`);
if (run.launchError) console.log(`No approval link. Layrcake said: ${run.launchError}`);
