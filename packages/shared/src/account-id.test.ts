import { describe, expect, test } from "bun:test";
import {
  ACCOUNT_ID_PLACEHOLDER,
  applyAccountId,
  findProvider,
  formatModelRef,
  isAccountIdMissing,
  parseModelRef,
  providerNeedsAccountId,
} from "./models";

const CLOUDFLARE_TEMPLATE =
  "https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1";

describe("account-scoped providers", () => {
  test("Cloudflare is registered and scoped to an account", () => {
    const provider = findProvider("cloudflare");

    expect(provider).toBeDefined();
    expect(provider!.defaultBaseUrl).toBe(CLOUDFLARE_TEMPLATE);
    expect(providerNeedsAccountId(provider!)).toBe(true);
    expect(provider!.accountId?.envVars).toContain("CLOUDFLARE_ACCOUNT_ID");
  });

  test("providers without an account scope are unaffected", () => {
    expect(providerNeedsAccountId(findProvider("openai")!)).toBe(false);
    expect(providerNeedsAccountId(findProvider("anthropic")!)).toBe(false);
  });

  test("substitutes the account id into the base URL", () => {
    expect(applyAccountId(CLOUDFLARE_TEMPLATE, "abc123")).toBe(
      "https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1",
    );
  });

  test("trims and escapes what the user typed", () => {
    expect(applyAccountId(CLOUDFLARE_TEMPLATE, "  abc123  ")).toContain("/accounts/abc123/");
    // A stray slash must not silently rewrite the path.
    expect(applyAccountId(CLOUDFLARE_TEMPLATE, "a/b")).toContain("/accounts/a%2Fb/");
  });

  test("reports a base URL that still needs an account id", () => {
    expect(isAccountIdMissing(CLOUDFLARE_TEMPLATE)).toBe(true);
    expect(isAccountIdMissing(applyAccountId(CLOUDFLARE_TEMPLATE, "abc123"))).toBe(false);
    expect(isAccountIdMissing("https://api.openai.com/v1")).toBe(false);
  });

  test("the placeholder is the one the template uses", () => {
    expect(CLOUDFLARE_TEMPLATE).toContain(ACCOUNT_ID_PLACEHOLDER);
  });
});

describe("model references for Cloudflare", () => {
  // Workers AI model ids contain slashes of their own, which is exactly the
  // case a naive `split("/")` would break.
  const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

  test("round-trips a model id that contains slashes", () => {
    const ref = formatModelRef("cloudflare", MODEL);

    expect(ref).toBe(`cloudflare/${MODEL}`);
    expect(parseModelRef(ref)).toEqual({ providerId: "cloudflare", modelId: MODEL });
  });

  test("keeps every segment of the model id", () => {
    expect(parseModelRef("cloudflare/@cf/openai/gpt-oss-120b")?.modelId).toBe(
      "@cf/openai/gpt-oss-120b",
    );
  });
});
