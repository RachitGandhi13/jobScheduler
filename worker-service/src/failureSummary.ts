/**
 * Turns a raw failure reason into a human-readable explanation + mitigation
 * for the Dead Letter Queue. Two paths:
 *
 *  - ANTHROPIC_API_KEY set: a real model call (claude-haiku-4-5, the
 *    cheapest current model -- this project has stayed zero-cost everywhere
 *    else, so a DLQ summary shouldn't be the one place that assumes a paid
 *    dependency is available).
 *  - unset (the default): a deterministic, zero-cost heuristic that pattern-
 *    matches the failure string against common signatures.
 *
 * Either path is best-effort: a summarization failure must never block the
 * dead-letter insert itself, so callers should treat a thrown error here the
 * same as "no summary available" (see execute.ts).
 */

interface FailureSignature {
  pattern: RegExp;
  explanation: string;
  mitigation: string;
}

const SIGNATURES: FailureSignature[] = [
  {
    pattern: /timeout|timed out|ETIMEDOUT/i,
    explanation: "The job's downstream call did not respond within its allotted time.",
    mitigation: "Check the target service's health/latency, and consider raising the job's own timeout or maxAttempts if the dependency is just slow, not down.",
  },
  {
    pattern: /ECONNREFUSED|connection refused/i,
    explanation: "The job couldn't establish a connection -- the target host is unreachable or not accepting connections on that port.",
    mitigation: "Verify the target service is running and its address/port are correct; check firewall or network policy changes.",
  },
  {
    pattern: /ENOTFOUND|getaddrinfo/i,
    explanation: "DNS resolution failed for the job's target host.",
    mitigation: "Confirm the hostname in the job payload is correct and that DNS is resolving it from wherever the worker runs.",
  },
  {
    pattern: /rate limit|429|too many requests/i,
    explanation: "The job was rejected by a downstream API's own rate limiter.",
    mitigation: "Lower this queue's concurrencyLimit, add a rate limit policy on this queue, or use a linear/exponential retry strategy to spread requests out.",
  },
  {
    pattern: /unauthorized|401|invalid.{0,20}(token|credential|key)/i,
    explanation: "The job's credentials were rejected by whatever it was calling.",
    mitigation: "Check whether the relevant API key/token has expired, been rotated, or was scoped incorrectly.",
  },
  {
    pattern: /forbidden|403/i,
    explanation: "The job's credentials were valid but lacked permission for this action.",
    mitigation: "Confirm the service account or API key has the required scope/role for this operation.",
  },
  {
    pattern: /validation|invalid (input|payload|argument)|400 /i,
    explanation: "The job's payload failed validation on the receiving end.",
    mitigation: "Compare the job's payload shape against what the downstream handler expects -- this is usually a stale or malformed payload, not a transient issue, so retrying alone won't fix it.",
  },
  {
    pattern: /cannot read propert|is not a function|undefined is not|null.{0,20}reference/i,
    explanation: "The job's handler crashed on a null/undefined value it assumed would be present.",
    mitigation: "A code-level bug in the job handler, not an infra issue -- add a null check or fix the payload producer; retrying without a code change will fail identically.",
  },
  {
    pattern: /out of memory|heap|ENOMEM/i,
    explanation: "The job exhausted available memory during execution.",
    mitigation: "Check the payload size and whether the handler streams or buffers the full input -- may need a payload size limit or streaming rewrite.",
  },
  {
    pattern: /deadlock|serialization failure|40P01/i,
    explanation: "The job's own database work collided with concurrent transactions.",
    mitigation: "Usually transient -- a fresh retry often succeeds; if it recurs, look for a lock-ordering issue in the handler's queries.",
  },
];

function heuristicSummary(jobType: string, failReason: string, attempts: number): string {
  const match = SIGNATURES.find((sig) => sig.pattern.test(failReason));
  if (match) {
    return `${match.explanation} Mitigation: ${match.mitigation}`;
  }
  return `Job "${jobType}" failed ${attempts} time(s), final error: "${failReason}". No known failure pattern matched -- inspect the job's payload and its handler's downstream dependency directly.`;
}

interface SummarizeParams {
  jobType: string;
  failReason: string;
  attempts: number;
}

async function callClaude(apiKey: string, { jobType, failReason, attempts }: SummarizeParams): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: `A background job named "${jobType}" permanently failed after ${attempts} attempt(s) and was moved to a dead letter queue. Its final error was:\n\n${failReason}\n\nIn under 80 words, explain the likely root cause and give one concrete mitigation step. Be specific and technical. No preamble, no markdown headers.`,
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API returned ${res.status}`);
  }

  const data = (await res.json()) as { content?: { text?: string }[] };
  const text = data.content?.[0]?.text?.trim();
  if (!text) {
    throw new Error("Anthropic API returned no text content");
  }
  return text;
}

export async function summarizeFailure(params: SummarizeParams): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    try {
      return await callClaude(apiKey, params);
    } catch {
      // Fall through to the heuristic -- a flaky/misconfigured API key must
      // never mean a dead-lettered job gets no summary at all.
    }
  }
  return heuristicSummary(params.jobType, params.failReason, params.attempts);
}
