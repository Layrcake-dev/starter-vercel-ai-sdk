import { createLayrcakeTools, LAYRCAKE_STOP_TOOL } from "@layrcake/ai-sdk";
import { generateText, hasToolCall, isStepCount, type LanguageModel } from "ai";
import type { Layrcake } from "layrcake";
import { instructions } from "./instructions.js";

export interface ProspectOptions {
  model: LanguageModel;
  brief: string;
  /** Credit ceiling for the whole run. */
  budget: number;
  /** Send dry_run: true on every Layrcake call. Nothing is charged. */
  dryRun: boolean;
  /** The name every drafted email is signed with. Without it, emails are signed [Your name]. */
  senderName?: string;
  /** Stable per run. Idempotency keys derive from it. */
  runId: string;
  /** Defaults to a client that reads LAYRCAKE_API_KEY. */
  client?: Layrcake;
  /** Called as each tool starts. */
  onToolCall?: (name: string) => void;
}

/**
 * One run of the agent: the brief in, the model's report and the run summary out.
 * The tools and their rules come from @layrcake/ai-sdk.
 */
export async function prospect({ model, brief, budget, dryRun, senderName, runId, client, onToolCall }: ProspectOptions) {
  const { tools, summary } = createLayrcakeTools({ client, budget, dryRun, runId });
  const result = await generateText({
    model,
    instructions: instructions({ budget, dryRun, senderName }),
    prompt: brief,
    tools,
    toolCallConcurrency: 1, // one Layrcake call at a time keeps the budget exact
    stopWhen: [hasToolCall(LAYRCAKE_STOP_TOOL), isStepCount(40)], // stop at the approval link
    onToolExecutionStart: ({ toolCall }) => onToolCall?.(toolCall.toolName),
  });
  return { text: result.text, summary: summary() };
}
