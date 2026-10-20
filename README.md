# Layrcake starter for the Vercel AI SDK

An AI SDK agent that turns a one-sentence brief into about 10 people with verified work emails and a draft campaign, then stops at the approval link.

It uses [`generateText`](https://ai-sdk.dev/docs/ai-sdk-core/generating-text) with tools from the [AI SDK](https://ai-sdk.dev), the Anthropic provider, and the [`@layrcake/ai-sdk`](https://github.com/Layrcake-dev/layrcake-ai-sdk) tools, which are built on the official [`layrcake`](https://github.com/Layrcake-dev/layrcake-js) TypeScript SDK. Nothing is sent. A person approves the campaign in the Layrcake console before any email goes out.

## What it does

1. `find_leads` finds people who match your brief.
2. `enrich` gets each person's work email.
3. `verify_email` checks every address. Only `valid` and `catch_all_valid` addresses are kept.
4. `create_campaign` saves a short draft sequence for the kept people. Drafts never send.
5. `launch_campaign` returns a preview and an approval link. The agent stops there.

## Why the SDK for this kit

Tools in the AI SDK are typed functions: an `inputSchema` and an `execute` function. `@layrcake/ai-sdk` wraps the `layrcake` SDK in five of them, which is the most direct fit:

- Each tool takes only the arguments this agent needs. `launch_campaign` has no `confirmation_token` argument, so the model cannot approve anything.
- The rules live in code in `@layrcake/ai-sdk`, which takes them from `layrcake/agent-tools` in the `layrcake` SDK, the one place every Layrcake agent integration gets them from. Every paid call gets `budget_credits` set to what is left of `BUDGET`. `--dry-run` adds `dry_run: true` to every call. `create_campaign` refuses any address that did not pass `verify_email` in this run. Once the approval link appears, every tool refuses.
- The SDK handles retries, typed errors and idempotency keys. The tools pass a key derived from the call, so a repeated call returns the first result instead of charging again.
- `toolCallConcurrency: 1` runs one Layrcake call at a time, so the running total is exact. `stopWhen: hasToolCall("launch_campaign")` ends the loop at the approval link.
- The `layrcake` package has no dependencies and runs on Node, Vercel Functions and Edge, so the same tools work in a route handler.

The hosted MCP server at `https://mcp.layrcake.dev/mcp` also works with the AI SDK. Plain tools keep the schemas small and the guardrails in your code.

To use OpenAI instead of Anthropic, run `npm install @ai-sdk/openai`, import `openai` from it, and change the `model` line in `src/agent.ts`.

## Prerequisites

- Node.js 22.12 or later.
- A Layrcake API key. Create one at [layrcake.dev/connect](https://layrcake.dev/connect). New accounts start with 300 free credits.
- An Anthropic API key from [platform.claude.com](https://platform.claude.com).
- Sending mailboxes in your Layrcake workspace, for the launch preview. Without them, `launch_campaign` returns an error that says what is missing, and the run reports it.

## Setup

```sh
npm install
cp .env.example .env   # then add LAYRCAKE_API_KEY and ANTHROPIC_API_KEY
npm run smoke          # free check of your Layrcake key, no model call
```

`npm run smoke` runs the agent's own tools in dry-run mode against the live API. It charges nothing and calls no model. It prints something like this:

```text
Key works for workspace "My workspace". Balance: 300 credits.
find_leads: would cost up to 3 credits
enrich: would cost up to 5 credits
verify_email: would cost up to 1.25 credits
create_campaign: would cost up to 0 credits

Charged: 0 credits. Your key and the Layrcake API work.
```

If `create_campaign` says it `would trip: sending_capacity`, connect mailboxes in the [Layrcake console](https://app.layrcake.dev) before a live run.

Set `SENDER_NAME` in `.env` to the name your emails are signed with. Without it, every draft is signed `[Your name]` and the report reminds you to fill it in before you approve.

## Run

Start with a dry run. Every Layrcake call returns a plan with its cost instead of data, so it is free. It still uses your Anthropic key.

```sh
npm start -- --dry-run
```

Then run it for real with your own brief:

```sh
npm start -- "Find 10 heads of sales at software companies in London with 20 to 200 staff and draft a short campaign about cutting time spent on lead research."
```

With no brief, it uses the one above.

## What you will see

Each tool call prints as it runs. The run ends with a short report from the tools themselves:

```text
Live run. Budget: 25 credits.
Brief: Find 3 heads of sales at software companies in London with 20 to 200 staff, verify their work emails, and draft a short campaign about cutting time spent on lead research.

-> find_leads
-> enrich
-> enrich
-> enrich
-> verify_email
-> verify_email
-> verify_email
-> create_campaign
-> launch_campaign

Found 10 people. Kept 3 verified emails (1 catch-all).
Layrcake credits spent: 21.75 of 25.
Nothing has been sent. A person approves or declines here: <approval link>
```

This is our test run on 20 October 2026, with `BUDGET=25`, the three-person brief above and `anthropic/claude-sonnet-5.5` through OpenRouter. It took 29 seconds. The search returned 10 people and the agent enriched the 3 the brief asked for. Your run will differ. A dry run ends with the model's cost estimate instead of a link.

## How approval works

`launch_campaign` never sends on its own. Its first answer is a preview, a `confirmation_token` and an `approval_url`. The tool returns the link and the loop stops.

A signed-in person in your workspace opens the link, reads the preview and approves or declines. Layrcake can also email an approver in your workspace. After approval, Layrcake starts the campaign itself when the approval says `execution: server`. Otherwise you repeat the call with the token. This agent never does either: its `launch_campaign` tool has no token argument.

## Cost

Our test runs of the default brief cost 45.5 to 53 Layrcake credits. A credit is $0.01. Finding people costs 0.25 credits each, an email costs 5 credits when found, a verification costs 1.25, and lookups that find nothing are free. Drafting the campaign is free. See [pricing](https://docs.layrcake.dev/pricing.html).

`BUDGET` in `.env` is the ceiling for the whole run (default 100). Model usage is billed separately by Anthropic. Set `MODEL` to change the model. The default is `claude-sonnet-5-5`.

## Using OpenRouter

The kit runs unchanged through [OpenRouter](https://openrouter.ai). Put these in `.env` instead of a direct model key:

```text
ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1
ANTHROPIC_API_KEY=<your OpenRouter key>
MODEL=anthropic/claude-sonnet-5.5
```

We ran this kit this way on 20 October 2026.

## Project layout

```text
src/agent.ts         the run: brief, budget, model, report
src/prospector.ts    the agent loop: tools from @layrcake/ai-sdk, stop conditions
src/instructions.ts  the system prompt
src/smoke.ts         free setup check, no model call
test/prospector.test.ts  agent loop tests with a mocked Layrcake API and a mock model
```

## Development

```sh
npm run lint
npm run typecheck
npm test
```

The tests pass a mocked `fetch` to the `Layrcake` client and run the agent with a mock language model. They need no keys and make no network calls. The tools themselves are tested in `@layrcake/ai-sdk` and `layrcake`.

## Links

- Layrcake docs: [docs.layrcake.dev](https://docs.layrcake.dev)
- Rules for agents: [layrcake.dev/agents.md](https://layrcake.dev/agents.md)
- TypeScript SDK: [github.com/Layrcake-dev/layrcake-js](https://github.com/Layrcake-dev/layrcake-js)
- Python SDK: [github.com/Layrcake-dev/layrcake-python](https://github.com/Layrcake-dev/layrcake-python)
- MCP server: `https://mcp.layrcake.dev/mcp`
- AI SDK: [ai-sdk.dev](https://ai-sdk.dev)

## License

MIT. See [LICENSE](LICENSE).
