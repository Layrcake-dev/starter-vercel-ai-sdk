import type { ToolExecutionOptions } from "ai";
import { Layrcake } from "layrcake";
import { describe, expect, it } from "vitest";
import { createLayrcakeTools, toMicro } from "../src/tools.js";

type Call = { path: string; body: Record<string, unknown>; idempotencyKey: string | null };

/** A Layrcake client whose fetch answers from a table instead of the network. */
function mockLayrcake(answers: Record<string, (body: Record<string, unknown>) => unknown>) {
  const calls: Call[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ path, body, idempotencyKey: new Headers(init?.headers).get("Idempotency-Key") });
    const answer = answers[path];
    if (!answer) return new Response(JSON.stringify({ error: { code: "not_found", message: path } }), { status: 404 });
    return new Response(JSON.stringify(answer(body)), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { client: new Layrcake({ apiKey: "lc_test", fetch: fetch as typeof globalThis.fetch, maxRetries: 0 }), calls };
}

const meta = (credits: string) => ({ request_id: "req_1", credits_charged: credits, credits_available: "250" });
const options = { toolCallId: "t1", messages: [] } as unknown as ToolExecutionOptions<never>;
const lead = { fingerprint: "f1", full_name: "Ada Lovelace", title: "Head of Sales", company_name: "Acme", company_domain: "acme.com", work_email: null, work_email_status: null, mobile_phone: null, linkedin_url: null, location: "London", observed_at: null };

function setup(budget = 100, dryRun = false) {
  const mock = mockLayrcake({
    "/v1/find_leads": () => ({ result: { leads: [lead], total_found: 1 }, layrcake: meta("3") }),
    "/v1/enrich": () => ({ result: { contact: { work_email: "ada@acme.com" } }, layrcake: meta("5.000000") }),
    "/v1/verify_email": (body) => ({ result: { email: body.email, status: body.email === "ada@acme.com" ? "valid" : "invalid" }, layrcake: meta("1.250000") }),
    "/v1/campaigns": () => ({ result: { campaign_id: "4f1c2b8e-0b7a-4c1e-9a55-2f6f1d2c3b4a", state: "draft", removed: { total: 0 } } }),
    "/v1/launch_campaign": (body) => ({ result: { status: "needs_confirmation", campaign_id: body.campaign_id, confirmation_token: "tok_1", approval_url: "https://app.layrcake.dev/approvals/a1" } }),
  });
  return { ...mock, ...createLayrcakeTools({ client: mock.client, budget, dryRun, runId: "run-test" }) };
}

const exec = <I, O>(tool: { execute?: (input: I, options: ToolExecutionOptions<never>) => unknown }, input: I) =>
  tool.execute?.(input, options) as Promise<O>;

describe("Layrcake tools", () => {
  it("caps each paid call at the budget left and sends an idempotency key", async () => {
    const { tools, calls, summary } = setup();
    const found = await exec(tools.find_leads, { audience: "Sales leaders", titles: ["Head of Sales"], limit: 10 });
    expect(found).toMatchObject({ leads: [{ full_name: "Ada Lovelace", company_domain: "acme.com" }], budget_left: 97 });
    expect(calls[0]).toMatchObject({ path: "/v1/find_leads", body: { budget_credits: 100, dry_run: false } });
    expect(calls[0]?.idempotencyKey).toMatch(/^run-test-find_leads-[0-9a-f]{24}$/);
    await exec(tools.enrich, { full_name: "Ada Lovelace", company_domain: "acme.com" });
    expect(calls[1]?.body).toMatchObject({ want: ["work_email"], budget_credits: 97 });
    expect(summary().spent).toBe(8);
  });

  it("requires a filter on find_leads before calling the API", async () => {
    const { tools, calls } = setup();
    await expect(exec(tools.find_leads, { audience: "Anyone", limit: 10 })).rejects.toThrow(/at least one of titles/);
    expect(calls).toHaveLength(0);
  });

  it("drafts campaigns only for verified emails", async () => {
    const { tools, summary } = setup();
    await exec(tools.verify_email, { email: "ada@acme.com" });
    await exec(tools.verify_email, { email: "bob@acme.com" });
    const steps = [{ subject: "Hi", body: "Hi {{first_name}}" }];
    await expect(exec(tools.create_campaign, { name: "Q4", leads: [{ email: "bob@acme.com" }], steps })).rejects.toThrow(/bob@acme.com/);
    await expect(exec(tools.create_campaign, { name: "Q4", leads: [{ email: "ada@acme.com" }], steps })).resolves.toMatchObject({ state: "draft" });
    expect(summary()).toMatchObject({ kept: 1, spent: 2.5 });
  });

  it("stops at the approval link", async () => {
    const { tools, summary } = setup();
    const preview = await exec(tools.launch_campaign, { campaign_id: "4f1c2b8e-0b7a-4c1e-9a55-2f6f1d2c3b4a" });
    expect(preview).toMatchObject({ status: "needs_confirmation", approval_url: "https://app.layrcake.dev/approvals/a1" });
    expect(summary().approvalUrl).toBe("https://app.layrcake.dev/approvals/a1");
    await expect(exec(tools.verify_email, { email: "x@acme.com" })).rejects.toThrow(/waiting for approval/);
  });

  it("keeps the reason when the launch preview fails", async () => {
    const mock = mockLayrcake({});
    const { tools, summary } = createLayrcakeTools({ client: mock.client, budget: 100, dryRun: false, runId: "run-test" });
    await expect(exec(tools.launch_campaign, { campaign_id: "4f1c2b8e-0b7a-4c1e-9a55-2f6f1d2c3b4a" })).rejects.toThrow();
    expect(summary().launchError).toMatch(/^not_found/);
  });

  it("refuses paid calls once the budget is spent", async () => {
    const { tools } = setup(5);
    await exec(tools.enrich, { full_name: "Ada Lovelace", company_domain: "acme.com" });
    await expect(exec(tools.enrich, { full_name: "Bob Smith", company_domain: "acme.com" })).rejects.toThrow(/budget/);
  });

  it("sends dry_run and returns the plan", async () => {
    const mock = mockLayrcake({
      "/v1/verify_email": () => ({ result: { dry_run: true, advisory: true, evaluated_at: "2026-10-20T00:00:00Z", plan: { verb: "verify_email", credits_estimate: "1.25", would_exceed: [], warnings: [] } }, layrcake: meta("0") }),
    });
    const { tools } = createLayrcakeTools({ client: mock.client, budget: 100, dryRun: true, runId: "run-test" });
    await expect(exec(tools.verify_email, { email: "ada@acme.com" })).resolves.toEqual({ dry_run: true, would_cost_up_to: "1.25", would_exceed: [], warnings: [] });
    expect(mock.calls[0]?.body).toMatchObject({ dry_run: true });
  });

  it("reads decimal credit strings exactly", () => {
    expect(toMicro("1.250000") + toMicro("0.25")).toBe(1_500_000);
  });
});
