// The tools and their rules are tested in @layrcake/ai-sdk and layrcake/agent-tools.
// These tests check this kit's agent loop: its instructions, its stop condition and its report.
import { MockLanguageModelV4 } from "ai/test";
import { Layrcake } from "layrcake";
import { describe, expect, it } from "vitest";
import { prospect } from "../src/prospector.js";

type Call = { path: string; body: Record<string, unknown> };

/** A Layrcake client whose fetch answers from a table instead of the network. */
function mockLayrcake(answers: Record<string, (body: Record<string, unknown>) => unknown>) {
  const calls: Call[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ path, body });
    const answer = answers[path];
    if (!answer) return new Response(JSON.stringify({ error: { code: "not_found", message: path } }), { status: 404 });
    return new Response(JSON.stringify(answer(body)), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { client: new Layrcake({ apiKey: "lc_test", fetch: fetch as typeof globalThis.fetch, maxRetries: 0 }), calls };
}

const CAMPAIGN_ID = "4f1c2b8e-0b7a-4c1e-9a55-2f6f1d2c3b4a";
const APPROVAL_URL = "https://app.layrcake.dev/approvals/a1";
const meta = (credits: string) => ({ request_id: "req_1", credits_charged: credits, credits_available: "250" });
const lead = { fingerprint: "f1", full_name: "Ada Lovelace", title: "Head of Sales", company_name: "Acme", company_domain: "acme.com", work_email: null, work_email_status: null, mobile_phone: null, linkedin_url: null, location: "London", observed_at: null };
const plan = (credits: string) => () => ({ result: { dry_run: true, advisory: true, evaluated_at: "2026-10-20T00:00:00Z", plan: { verb: "x", credits_estimate: credits, would_exceed: [], warnings: [] } }, layrcake: meta("0") });

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
/** A model that makes these tool calls, one per step, then writes a report. */
function scriptedModel(steps: [string, Record<string, unknown>][], report: string) {
  return new MockLanguageModelV4({
    doGenerate: [
      ...steps.map(([toolName, input], i) => ({
        content: [{ type: "tool-call" as const, toolCallId: `c${i}`, toolName, input: JSON.stringify(input) }],
        finishReason: { unified: "tool-calls" as const, raw: undefined },
        usage,
        warnings: [],
      })),
      { content: [{ type: "text" as const, text: report }], finishReason: { unified: "stop" as const, raw: undefined }, usage, warnings: [] },
    ],
  });
}

const sample = { email: "sample.person@example.com", first_name: "Sample" };

describe("the prospector agent", () => {
  it("finds, verifies and drafts, then stops at the approval link", async () => {
    const steps: [string, Record<string, unknown>][] = [
      ["find_leads", { audience: "Sales leaders in London", titles: ["Head of Sales"] }],
      ["enrich", { full_name: "Ada Lovelace", company_domain: "acme.com" }],
      ["verify_email", { email: "ada@acme.com" }],
      ["create_campaign", { name: "Q4", leads: [{ email: "ada@acme.com", first_name: "Ada" }], steps: [{ subject: "Hi", body: "Hi {{first_name}}" }] }],
      ["launch_campaign", { campaign_id: CAMPAIGN_ID }],
    ];
    const model = scriptedModel(steps, "This step must never run.");
    const { client, calls } = mockLayrcake({
      "/v1/find_leads": () => ({ result: { leads: [lead], total_found: 1 }, layrcake: meta("3") }),
      "/v1/enrich": () => ({ result: { contact: { work_email: "ada@acme.com" } }, layrcake: meta("5.000000") }),
      "/v1/verify_email": (body) => ({ result: { email: body.email, status: "valid" }, layrcake: meta("1.250000") }),
      "/v1/campaigns": () => ({ result: { campaign_id: CAMPAIGN_ID, state: "draft", removed: { total: 0 } } }),
      "/v1/launch_campaign": (body) => ({ result: { status: "needs_confirmation", campaign_id: body.campaign_id, confirmation_token: "tok_1", approval_url: APPROVAL_URL } }),
    });
    const logged: string[] = [];

    const { summary } = await prospect({ model, brief: "Find heads of sales in London", budget: 100, dryRun: false, runId: "run-test", client, onToolCall: (name) => logged.push(name) });

    expect(logged).toEqual(steps.map(([name]) => name));
    expect(calls.map((c) => c.path)).toEqual(["/v1/find_leads", "/v1/enrich", "/v1/verify_email", "/v1/campaigns", "/v1/launch_campaign"]);
    expect(calls[0]?.body).toMatchObject({ budget_credits: 100, dry_run: false, limit: 10 });
    expect(calls[4]?.body).toEqual({ campaign_id: CAMPAIGN_ID, dry_run: false });
    expect(model.doGenerateCalls).toHaveLength(5);
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain("budget of 100 credits");
    expect(summary).toEqual({ found: 1, kept: 1, catchAll: 0, spent: 9.25, approvalUrl: APPROVAL_URL, launchError: null });
  });

  it("runs a dry run with dry_run on every call and charges nothing", async () => {
    const steps: [string, Record<string, unknown>][] = [
      ["find_leads", { audience: "Sales leaders in London", titles: ["Head of Sales"] }],
      ["enrich", { full_name: "Sample Person", company_domain: "example.com" }],
      ["verify_email", { email: sample.email }],
      ["create_campaign", { name: "Q4", leads: [sample], steps: [{ subject: "Hi", body: "Hi {{first_name}}" }] }],
    ];
    const model = scriptedModel(steps, "Estimate for 10 people: about 66 credits.");
    const { client, calls } = mockLayrcake({ "/v1/find_leads": plan("3"), "/v1/enrich": plan("5"), "/v1/verify_email": plan("1.25"), "/v1/campaigns": plan("0") });

    const { text, summary } = await prospect({ model, brief: "Find heads of sales in London", budget: 100, dryRun: true, runId: "run-test", client });

    expect(calls.map((c) => c.body.dry_run)).toEqual([true, true, true, true]);
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain("This is a dry run");
    expect(text).toBe("Estimate for 10 people: about 66 credits.");
    expect(summary).toMatchObject({ spent: 0, approvalUrl: null });
  });
});
