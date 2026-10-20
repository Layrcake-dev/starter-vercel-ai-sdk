import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { anthropic } from "@ai-sdk/anthropic";
import { DEFAULT_BRIEF } from "./instructions.js";
import { prospect } from "./prospector.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { "dry-run": { type: "boolean", default: false } } });
const dryRun = values["dry-run"];
const brief = positionals.join(" ") || DEFAULT_BRIEF;
const budget = Number(process.env.BUDGET ?? 100);
if (!process.env.LAYRCAKE_API_KEY) throw new Error("Set LAYRCAKE_API_KEY. Get a key at https://layrcake.dev/connect");
if (!process.env.ANTHROPIC_API_KEY) throw new Error("Set ANTHROPIC_API_KEY. Get one at https://platform.claude.com");
if (!(budget > 0)) throw new Error("BUDGET must be a positive number of credits.");

console.log(`${dryRun ? "Dry run, nothing is charged" : "Live run"}. Budget: ${budget} credits.\nBrief: ${brief}\n`);
const { text, summary: run } = await prospect({
  model: anthropic(process.env.MODEL ?? "claude-sonnet-5-5"),
  brief,
  budget,
  dryRun,
  runId: randomUUID(),
  onToolCall: (name) => console.log(`-> ${name}`),
});

if (text) console.log(`\n${text}`);
console.log(`\nFound ${run.found} people. Kept ${run.kept} verified emails (${run.catchAll} catch-all).`);
console.log(`Layrcake credits spent: ${run.spent} of ${budget}.`);
if (run.approvalUrl) console.log(`Nothing has been sent. A person approves or declines here: ${run.approvalUrl}`);
if (run.launchError) console.log(`No approval link. Layrcake said: ${run.launchError}`);
