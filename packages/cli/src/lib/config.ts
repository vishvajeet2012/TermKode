// TermKode ships its API in the same process as the CLI, so requests never
// touch the network. The base URL only exists to give the typed Hono client
// absolute URLs to build; nothing ever resolves this host. Set `API_URL` to
// point the CLI at a separately running TermKode server instead.
export const LOCAL_API_URL = "http://termkode.local";

export function getApiUrl() {
  return (process.env.API_URL ?? LOCAL_API_URL).replace(/\/+$/, "");
}

export function isUsingRemoteApi() {
  return Boolean(process.env.API_URL);
}
