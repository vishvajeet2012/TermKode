import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "termkode-bedrock-"));
process.env.TERMKODE_HOME = home;
delete process.env.AWS_BEARER_TOKEN_BEDROCK;
delete process.env.BEDROCK_API_KEY;
delete process.env.AWS_REGION;
delete process.env.AWS_DEFAULT_REGION;

const { app } = await import("../index");

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("Amazon Bedrock provider setup", () => {
  test("shows Bedrock in /providers with a region prompt", async () => {
    const response = await app.request("/providers");
    expect(response.status).toBe(200);

    const body = await response.json() as {
      providers: Array<{
        id: string;
        label: string;
        ready: boolean;
        needsAccountId: boolean;
        accountIdLabel: string | null;
        accountIdEnvVar: string | null;
        apiKeyEnvVar: string | null;
        apiKeyUrl: string | null;
      }>;
    };

    const bedrock = body.providers.find((provider) => provider.id === "bedrock");
    expect(bedrock).toBeDefined();
    expect(bedrock!.label).toBe("Amazon Bedrock");
    expect(bedrock!.ready).toBe(false);
    expect(bedrock!.needsAccountId).toBe(true);
    expect(bedrock!.accountIdLabel).toBe("AWS Region");
    expect(bedrock!.accountIdEnvVar).toBe("AWS_REGION");
    expect(bedrock!.apiKeyEnvVar).toBe("AWS_BEARER_TOKEN_BEDROCK");
    expect(bedrock!.apiKeyUrl).toContain("bedrock");
  });

  test("refuses to save a Bedrock key without a region", async () => {
    const response = await app.request("/providers/bedrock", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "ABSKTESTKEY" }),
    });

    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toMatch(/region/i);
  });

  test("rejects a fake Bedrock API key against AWS", async () => {
    const response = await app.request("/providers/bedrock", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "ABSKTESTKEY", accountId: "us-east-1" }),
    });

    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error.length).toBeGreaterThan(0);
    expect(body.error).not.toMatch(/Internal Server Error/i);
  }, 20_000);
});
