import { hc } from "hono/client";
import { app, type AppType } from "@termkode/server";
import { getApiUrl, isUsingRemoteApi } from "./config";

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

function toRequest(input: FetchInput, init?: FetchInit) {
  const requestInit = init as RequestInit | undefined;

  if (input instanceof Request) {
    return requestInit ? new Request(input, requestInit) : input;
  }

  return new Request(input.toString(), requestInit);
}

// Route every request straight into the embedded Hono app. There is no server
// to start, no port to bind, and no account to sign in to: the CLI is the API.
export const localFetch: typeof globalThis.fetch = Object.assign(
  async (input: FetchInput, init?: FetchInit) => {
    return app.fetch(toRequest(input, init));
  },
  // Nothing in the terminal client calls `fetch.preconnect`, but the type
  // carries it, so keep the platform implementation.
  { preconnect: globalThis.fetch.preconnect },
);

export const apiClient = hc<AppType>(getApiUrl(), {
  fetch: isUsingRemoteApi() ? fetch : localFetch,
});
