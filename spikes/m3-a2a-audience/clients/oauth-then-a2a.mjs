// A standard OAuth 2.1 client gets an /a2a token, and the A2A SDK client uses it. Against `npm run dev`.
// Neither A2A SDK runs an OAuth flow itself, so the MCP SDK's generic one stands in: RFC 9728 discovery from /a2a,
// dynamic registration, PKCE, and RFC 8707 `resource`. Nothing in either SDK is patched.
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory } from "@a2a-js/sdk/client";

const BASE = process.env.SUT ?? "http://localhost:8787";
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };

function provider() {
  let info, tokens, verifier, authUrl;
  return {
    get redirectUrl() { return "http://127.0.0.1:9999/callback"; },
    get clientMetadata() { return { redirect_uris: ["http://127.0.0.1:9999/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], client_name: "spike-b" }; },
    clientInformation: () => info, saveClientInformation: (i) => { info = i; },
    tokens: () => tokens, saveTokens: (t) => { tokens = t; },
    saveCodeVerifier: (v) => { verifier = v; }, codeVerifier: () => verifier,
    redirectToAuthorization: (url) => { authUrl = url; },
    get authUrl() { return authUrl; },
  };
}

async function tokenFor(resourcePath) {
  const p = provider();
  const serverUrl = `${BASE}${resourcePath}`;
  check(`${resourcePath}: first step asks to redirect`, (await auth(p, { serverUrl })) === "REDIRECT");
  check(`${resourcePath}: authorize URL names the resource`, p.authUrl.searchParams.get("resource") === serverUrl, p.authUrl.searchParams.get("resource"));
  // The stand-in consent page approves at once, so following one redirect gives the code.
  const res = await fetch(p.authUrl, { redirect: "manual" });
  const code = new URL(res.headers.get("location")).searchParams.get("code");
  check(`${resourcePath}: token exchanged`, (await auth(p, { serverUrl, authorizationCode: code })) === "AUTHORIZED");
  return p.tokens().access_token;
}

await fetch(`${BASE}/spike/disconnect`, { method: "POST" });
const a2aToken = await tokenFor("/a2a");
const mcpToken = await tokenFor("/mcp");

const withToken = (token) => (input, init = {}) => fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), authorization: `Bearer ${token}` } });
const client = (token) => new ClientFactory({ ...ClientFactoryOptions.default, transports: [new JsonRpcTransportFactory({ fetchImpl: withToken(token) })] }).createFromUrl(BASE);

const task = await (await client(a2aToken)).getTask({ id: "tsk_whoami" });
check("A2A client with the /a2a token reaches GetTask as the agent", task.metadata?.agent === "agt_spike", task.metadata?.agent);
try { await (await client(mcpToken)).getTask({ id: "tsk_whoami" }); check("A2A client with an /mcp token is refused", false); }
catch (e) { check("A2A client with an /mcp token is refused", true, e.constructor.name); }
check("/a2a token refused at /mcp", (await fetch(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${a2aToken}` } })).status === 401);
check("/a2a token refused at /v1/files", (await fetch(`${BASE}/v1/files/fil_1`, { headers: { authorization: `Bearer ${a2aToken}` } })).status === 401);

const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
