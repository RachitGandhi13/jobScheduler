import { describe, expect, it } from "vitest";
import { summarizeFailure } from "../failureSummary.js";

describe("summarizeFailure -- heuristic path (no ANTHROPIC_API_KEY configured)", () => {
  it("matches a timeout failure to its signature's explanation and mitigation", async () => {
    const summary = await summarizeFailure({
      jobType: "sync-inventory",
      failReason: "Error: request to https://api.example.com timed out after 30000ms (ETIMEDOUT)",
      attempts: 3,
    });
    expect(summary).toMatch(/did not respond within its allotted time/i);
    expect(summary).toMatch(/Mitigation:/);
  });

  it("matches a rate-limit failure distinctly from a timeout", async () => {
    const summary = await summarizeFailure({
      jobType: "send-email",
      failReason: "Request failed with status code 429: Too Many Requests",
      attempts: 5,
    });
    expect(summary).toMatch(/rate limiter/i);
    expect(summary).toMatch(/concurrencyLimit/i);
  });

  it("matches a null-reference crash to a code-bug explanation, not an infra one", async () => {
    const summary = await summarizeFailure({
      jobType: "generate-report",
      failReason: "TypeError: Cannot read properties of undefined (reading 'id')",
      attempts: 3,
    });
    expect(summary).toMatch(/handler crashed/i);
  });

  it("falls back to a generic-but-informative summary when no signature matches", async () => {
    const summary = await summarizeFailure({
      jobType: "custom-task",
      failReason: "Something extremely unusual and specific to this one integration went wrong",
      attempts: 2,
    });
    expect(summary).toContain("custom-task");
    expect(summary).toContain("2 time(s)");
    expect(summary).toMatch(/no known failure pattern/i);
  });
});
