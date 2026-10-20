import { createHash } from "node:crypto";
import { tool } from "ai";
import { getApproval, LayrcakeError, type Layrcake } from "layrcake";
import { z } from "zod";

/** verify_email answers we send to. Everything else is dropped. */
const SENDABLE = new Set(["valid", "catch_all_valid"]);
const MICRO = 1_000_000;

/** Credits arrive as decimal strings ("1.250000"). Count them in whole micro-credits, never floats. */
export function toMicro(credits: unknown): number {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(credits ?? "0"));
  return match ? Number(match[1]) * MICRO + Number((match[2] ?? "").padEnd(6, "0")) : 0;
}

type Plan = { credits_estimate: string; would_exceed: string[]; warnings: unknown[] };
const isPlan = (result: unknown): result is { plan: Plan } => typeof result === "object" && result !== null && "plan" in result;
const planOutput = ({ plan }: { plan: Plan }) => ({ dry_run: true, would_cost_up_to: plan.credits_estimate, would_exceed: plan.would_exceed, warnings: plan.warnings });

export interface LayrcakeToolsOptions {
  client: Layrcake;
  /** Credit ceiling for the whole run. */
  budget: number;
  /** Send dry_run: true on every call. Nothing is charged. */
  dryRun: boolean;
  /** Stable per run. Idempotency keys derive from it, so a repeated call is never charged twice. */
  runId: string;
}

export function createLayrcakeTools({ client, budget, dryRun, runId }: LayrcakeToolsOptions) {
  const run = { spentMicro: 0, found: 0, kept: 0, catchAll: 0, approvalUrl: null as string | null, launchError: null as string | null, verified: new Set<string>() };
  const left = () => (budget * MICRO - run.spentMicro) / MICRO;
  const key = (verb: string, input: unknown) =>
    `${runId}-${verb}-${createHash("sha256").update(JSON.stringify({ input, dryRun })).digest("hex").slice(0, 24)}`;

  /** Every paid call: refuse past the budget, cap it at what is left, count what it cost. */
  async function paid<T extends { layrcake: { credits_charged?: string } | null }>(call: (ceiling: number) => Promise<T>) {
    if (run.approvalUrl) throw new Error("The campaign is waiting for approval. Stop and report the approval link.");
    if (left() < 0.01) throw new Error(`The run budget of ${budget} credits is spent. Stop and report.`);
    const response = await call(Math.min(Math.floor(left() * 100) / 100, 2000));
    run.spentMicro += toMicro(response.layrcake?.credits_charged);
    return response;
  }

  const tools = {
    find_leads: tool({
      description: "Find people who match an audience. Send audience plus at least one of titles, industries, locations or company_domains.",
      inputSchema: z.object({
        audience: z.string().min(1).describe("Who you want, in plain words"),
        titles: z.array(z.string()).max(50).optional().describe('Job titles, e.g. ["Head of Sales", "VP Sales"]'),
        industries: z.array(z.string()).max(50).optional().describe('LinkedIn industry names or everyday words, e.g. ["Software Development"]'),
        locations: z.array(z.string()).max(50).optional().describe('e.g. ["London, United Kingdom"]'),
        company_domains: z.array(z.string()).max(100).optional().describe("Only people at these companies"),
        company_headcount: z.object({ min: z.number().int().min(1).optional(), max: z.number().int().min(1).optional() }).optional(),
        limit: z.number().int().min(1).max(25).default(10),
      }),
      execute: async (input) => {
        if (!input.titles?.length && !input.industries?.length && !input.locations?.length && !input.company_domains?.length) {
          throw new Error("Add at least one of titles, industries, locations or company_domains.");
        }
        const { result, layrcake } = await paid((ceiling) =>
          client.findLeads({ ...input, budget_credits: ceiling, dry_run: dryRun }, { idempotencyKey: key("find_leads", input) }),
        );
        if (isPlan(result)) return planOutput(result);
        run.found += result.leads.length;
        const leads = result.leads.map(({ full_name, title, company_name, company_domain, location }) => ({ full_name, title, company_name, company_domain, location }));
        return { leads, total_found: result.total_found, credits_charged: layrcake?.credits_charged, budget_left: left() };
      },
    }),

    enrich: tool({
      description: "Find one person's work email from their full name and company domain. 5 credits when found, free when not.",
      inputSchema: z.object({ full_name: z.string().min(1), company_domain: z.string().min(1) }),
      execute: async (person) => {
        const { result, layrcake } = await paid((ceiling) =>
          client.enrich({ person, want: ["work_email"], budget_credits: ceiling, dry_run: dryRun }, { idempotencyKey: key("enrich", person) }),
        );
        if (isPlan(result)) return planOutput(result);
        return { work_email: result.contact?.work_email ?? null, credits_charged: layrcake?.credits_charged, budget_left: left() };
      },
    }),

    verify_email: tool({
      description: "Check that an address can receive mail. Keep valid and catch_all_valid. Drop everything else.",
      inputSchema: z.object({ email: z.string().min(3) }),
      execute: async ({ email }) => {
        const { result, layrcake } = await paid((ceiling) =>
          client.verifyEmail({ email, budget_credits: ceiling, dry_run: dryRun }, { idempotencyKey: key("verify_email", email) }),
        );
        if (isPlan(result)) return planOutput(result);
        const keep = SENDABLE.has(result.status);
        if (keep && !run.verified.has(email.toLowerCase())) {
          run.verified.add(email.toLowerCase());
          run.kept += 1;
          if (result.status === "catch_all_valid") run.catchAll += 1;
        }
        return { email, status: result.status, keep, credits_charged: layrcake?.credits_charged, budget_left: left() };
      },
    }),

    create_campaign: tool({
      description: "Save a draft campaign for verified people. Drafts never send. Free.",
      inputSchema: z.object({
        name: z.string().min(1).max(120),
        leads: z.array(z.object({
          email: z.string(),
          first_name: z.string().optional(),
          last_name: z.string().optional(),
          company_name: z.string().optional(),
          location: z.string().max(200).optional(),
        })).min(1).max(50),
        steps: z.array(z.object({
          subject: z.string().min(1).max(300).optional().describe("Subject line"),
          body: z.string().min(1).describe("Plain text. Use {{first_name}}."),
          wait_days: z.number().int().min(0).max(60).optional(),
        })).min(1).max(3),
      }),
      execute: async (input) => {
        const unverified = input.leads.filter((lead) => !run.verified.has(lead.email.toLowerCase())).map((lead) => lead.email);
        if (!dryRun && unverified.length) throw new Error(`Verify these first, or drop them: ${unverified.join(", ")}`);
        const { result } = await client.createCampaign({ ...input, dry_run: dryRun }, { idempotencyKey: key("create_campaign", input) });
        if (isPlan(result)) return planOutput(result);
        return { campaign_id: result.campaign_id, state: result.state, removed: result.removed };
      },
    }),

    launch_campaign: tool({
      description: "Ask a person to approve the draft. Sends nothing. Returns a preview and an approval link. Call it once, last.",
      inputSchema: z.object({ campaign_id: z.uuid() }),
      execute: async ({ campaign_id }) => {
        const response = await client
          .launchCampaign({ campaign_id, dry_run: dryRun }, { idempotencyKey: key("launch_campaign", campaign_id) })
          .catch((error: unknown) => {
            // The loop stops after this tool, so keep the reason for the final report.
            if (error instanceof LayrcakeError) run.launchError = `${error.code}: ${error.message}`;
            throw error;
          });
        if (isPlan(response.result)) return planOutput(response.result);
        const approval = getApproval(response);
        run.approvalUrl = approval?.approvalUrl ?? null;
        return { status: response.result.status, approval_url: run.approvalUrl, preview: response.result };
      },
    }),
  };

  return {
    tools,
    /** What the run did, for the report printed at the end. */
    summary: () => ({ found: run.found, kept: run.kept, catchAll: run.catchAll, spent: run.spentMicro / MICRO, approvalUrl: run.approvalUrl, launchError: run.launchError }),
  };
}
