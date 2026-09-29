import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const clientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const authorizationEndpoint = "https://auth.openai.com/oauth/authorize";
const tokenEndpoint = "https://auth.openai.com/oauth/token";
const redirectUri = "http://localhost:1455/auth/callback";
const authDirectory = path.join(homedir(), ".config", "maekress");
const authPath = path.join(authDirectory, "auth.json");
const authClaim = "https://api.openai.com/auth";

export type CodexCredential = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
};

export type McpOAuthCredential = {
  serverUrl: string;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
};

type AuthFile = { codex?: CodexCredential; apiKeys?: Record<string, string>; mcpOAuth?: Record<string, McpOAuthCredential> };

async function readAuthFile(): Promise<AuthFile> {
  try {
    return JSON.parse(await readFile(authPath, "utf8")) as AuthFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function saveAuthFile(auth: AuthFile): Promise<void> {
  await mkdir(authDirectory, { recursive: true, mode: 0o700 });
  await chmod(authDirectory, 0o700);
  const temporaryPath = `${authPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, authPath);
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function accountIdFromToken(accessToken: string): string {
  const payloadSegment = accessToken.split(".")[1];
  if (!payloadSegment) throw new Error("OpenAI returned an invalid access token.");
  const payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8")) as Record<string, unknown>;
  const auth = payload[authClaim] as Record<string, unknown> | undefined;
  if (typeof auth?.chatgpt_account_id !== "string") {
    throw new Error("OpenAI access token did not include a ChatGPT account ID.");
  }
  return auth.chatgpt_account_id;
}

async function exchangeToken(parameters: URLSearchParams, signal?: AbortSignal): Promise<CodexCredential> {
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: parameters,
    signal,
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const detail = typeof body.error_description === "string" ? body.error_description : String(body.error ?? response.statusText);
    throw new Error(`OpenAI sign-in failed: ${detail}`);
  }
  if (typeof body.access_token !== "string" || typeof body.refresh_token !== "string") {
    throw new Error("OpenAI returned an incomplete token response.");
  }
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + expiresIn * 1000,
    accountId: accountIdFromToken(body.access_token),
  };
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

async function exchangeMcpToken(endpoint: string, parameters: URLSearchParams, clientSecret?: string, signal?: AbortSignal): Promise<{ accessToken: string; refreshToken?: string; expiresAt: number; scope?: string }> {
  if (clientSecret) parameters.set("client_secret", clientSecret);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: parameters,
    signal,
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const detail = typeof body.error_description === "string" ? body.error_description : String(body.error ?? response.statusText);
    throw new Error(`MCP OAuth failed: ${detail}`);
  }
  if (typeof body.access_token !== "string") throw new Error("MCP OAuth returned no access token.");
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
  return {
    accessToken: body.access_token,
    ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
    expiresAt: Date.now() + expiresIn * 1000,
    ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
  };
}

function protectedResourceMetadataCandidates(serverUrl: string): string[] {
  const url = new URL(serverUrl);
  const pathPart = url.pathname.replace(/\/$/, "");
  return [
    `${url.origin}/.well-known/oauth-protected-resource${pathPart}`,
    `${url.origin}/.well-known/oauth-protected-resource`,
  ];
}

export async function loginMcpOAuth(options: {
  key: string;
  serverUrl: string;
  resourceMetadataUrl?: string;
  scope: string;
  callbackPort?: number;
}, onAuthUrl: (url: string) => void, signal?: AbortSignal): Promise<void> {
  const callbackPort = options.callbackPort ?? 1456;
  const redirectUri = `http://localhost:${callbackPort}/auth/mcp/callback`;
  let resourceMetadata: { resource?: string; authorization_servers?: string[] } | undefined;
  const metadataCandidates = options.resourceMetadataUrl ? [options.resourceMetadataUrl] : protectedResourceMetadataCandidates(options.serverUrl);
  for (const metadataUrl of metadataCandidates) {
    const response = await fetch(metadataUrl, { signal }).catch(() => undefined);
    if (!response?.ok) continue;
    resourceMetadata = await response.json() as { resource?: string; authorization_servers?: string[] };
    break;
  }
  if (!resourceMetadata) throw new Error("Could not discover MCP protected resource metadata.");
  const issuer = resourceMetadata.authorization_servers?.[0];
  if (!issuer || typeof issuer !== "string") throw new Error("MCP server did not advertise an OAuth authorization server.");
  const metadataUrl = new URL(issuer);
  metadataUrl.pathname = "/.well-known/oauth-authorization-server";
  const metadata = await (await fetch(metadataUrl, { signal })).json() as Record<string, unknown>;
  const authorizationEndpoint = metadata.authorization_endpoint;
  const tokenEndpoint = metadata.token_endpoint;
  const registrationEndpoint = metadata.registration_endpoint;
  if (typeof authorizationEndpoint !== "string" || typeof tokenEndpoint !== "string") throw new Error("MCP authorization server metadata is incomplete.");
  let clientId: string;
  let clientSecret: string | undefined;
  if (typeof registrationEndpoint === "string") {
    const registration = await fetch(registrationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "maekress",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      signal,
    });
    const registered = await registration.json().catch(() => ({})) as Record<string, unknown>;
    if (!registration.ok) throw new Error(`MCP client registration failed: ${String(registered.error_description ?? registered.error ?? registration.statusText)}`);
    if (typeof registered.client_id !== "string") throw new Error("MCP client registration returned no client_id.");
    clientId = registered.client_id;
    if (typeof registered.client_secret === "string") clientSecret = registered.client_secret;
  } else {
    throw new Error("MCP OAuth server requires a pre-registered client; this harness only supports dynamic registration for now.");
  }

  const verifier = base64Url(randomBytes(32));
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = base64Url(randomBytes(24));
  const resource = resourceMetadata.resource ?? options.serverUrl;
  const authorizeUrl = new URL(authorizationEndpoint);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: options.scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    resource,
  }).toString();

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((request, response) => {
      const callback = new URL(request.url ?? "/", redirectUri);
      if (callback.pathname !== "/auth/mcp/callback") return void response.writeHead(404).end("Not found");
      if (callback.searchParams.get("state") !== state) {
        response.writeHead(400, { "Content-Type": "text/plain" }).end("OAuth state did not match. You can close this tab.");
        reject(new Error("MCP OAuth state did not match."));
        server.close();
        return;
      }
      const error = callback.searchParams.get("error_description") ?? callback.searchParams.get("error");
      const authCode = callback.searchParams.get("code");
      if (!authCode || error) {
        response.writeHead(400, { "Content-Type": "text/plain" }).end("Sign-in did not complete. You can close this tab.");
        reject(new Error(`MCP sign-in was not completed${error ? `: ${error}` : "."}`));
        server.close();
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Signed in</title><p>Signed in to maekress MCP. You can return to the terminal.</p>");
      resolve(authCode);
      server.close();
    });
    server.once("error", reject);
    server.listen(callbackPort, "127.0.0.1", () => {
      const timeout = setTimeout(() => {
        reject(new Error("MCP sign-in timed out."));
        server.close();
      }, 5 * 60 * 1000);
      timeout.unref();
      signal?.addEventListener("abort", () => {
        clearTimeout(timeout);
        reject(new Error("MCP sign-in cancelled."));
        server.close();
      }, { once: true });
      onAuthUrl(authorizeUrl.toString());
      openBrowser(authorizeUrl.toString());
    });
  });

  const token = await exchangeMcpToken(tokenEndpoint, new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    client_id: clientId,
    resource,
  }), clientSecret, signal);
  const auth = await readAuthFile();
  auth.mcpOAuth ??= {};
  auth.mcpOAuth[options.key] = { serverUrl: options.serverUrl, issuer, clientId, ...(clientSecret ? { clientSecret } : {}), ...token };
  await saveAuthFile(auth);
}

export async function loginCodex(onAuthUrl: (url: string) => void, signal?: AbortSignal): Promise<void> {
  const verifier = base64Url(randomBytes(32));
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = base64Url(randomBytes(24));
  const authorizeUrl = new URL(authorizationEndpoint);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "maekress",
  }).toString();

  const result = new Promise<string>((resolve, reject) => {
    const server = createServer((request, response) => {
      const callback = new URL(request.url ?? "/", redirectUri);
      if (callback.pathname !== "/auth/callback") {
        response.writeHead(404).end("Not found");
        return;
      }
      if (callback.searchParams.get("state") !== state) {
        response.writeHead(400, { "Content-Type": "text/plain" }).end("Sign-in state did not match. You can close this tab.");
        reject(new Error("OpenAI sign-in state did not match."));
        server.close();
        return;
      }
      const error = callback.searchParams.get("error_description") ?? callback.searchParams.get("error");
      const code = callback.searchParams.get("code");
      if (!code || error) {
        response.writeHead(400, { "Content-Type": "text/plain" }).end("Sign-in did not complete. You can close this tab.");
        reject(new Error(`OpenAI sign-in was not completed${error ? `: ${error}` : "."}`));
        server.close();
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Signed in</title><p>Signed in to maekress. You can return to the terminal.</p>");
      resolve(code);
      server.close();
    });

    server.once("error", reject);
    server.listen(1455, "127.0.0.1", () => {
      const timeout = setTimeout(() => {
        reject(new Error("OpenAI sign-in timed out."));
        server.close();
      }, 5 * 60 * 1000);
      timeout.unref();
      signal?.addEventListener("abort", () => {
        clearTimeout(timeout);
        reject(new Error("OpenAI sign-in cancelled."));
        server.close();
      }, { once: true });
      onAuthUrl(authorizeUrl.toString());
      openBrowser(authorizeUrl.toString());
    });
  });

  const code = await result;
  const credential = await exchangeToken(new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    client_id: clientId,
  }), signal);
  const auth = await readAuthFile();
  auth.codex = credential;
  await saveAuthFile(auth);
}

export async function getCodexCredential(): Promise<CodexCredential | undefined> {
  const auth = await readAuthFile();
  const credential = auth.codex;
  if (!credential) return undefined;
  if (credential.expiresAt > Date.now() + 60_000) return credential;
  const refreshed = await exchangeToken(new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credential.refreshToken,
    client_id: clientId,
  }));
  auth.codex = refreshed;
  await saveAuthFile(auth);
  return refreshed;
}

export async function getMcpOAuthCredential(key: string): Promise<McpOAuthCredential | undefined> {
  const auth = await readAuthFile();
  const credential = auth.mcpOAuth?.[key];
  if (!credential) return undefined;
  if (credential.expiresAt > Date.now() + 60_000) return credential;
  if (!credential.refreshToken) return credential;
  const metadataUrl = new URL(credential.issuer);
  metadataUrl.pathname = "/.well-known/oauth-authorization-server";
  const metadata = await (await fetch(metadataUrl)).json() as Record<string, unknown>;
  if (typeof metadata.token_endpoint !== "string") return credential;
  const refreshed = await exchangeMcpToken(metadata.token_endpoint, new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credential.refreshToken,
    client_id: credential.clientId,
    resource: credential.serverUrl,
  }), credential.clientSecret);
  const next = { ...credential, ...refreshed, refreshToken: refreshed.refreshToken ?? credential.refreshToken };
  auth.mcpOAuth![key] = next;
  await saveAuthFile(auth);
  return next;
}

export async function removeMcpOAuthCredential(key: string): Promise<boolean> {
  const auth = await readAuthFile();
  if (!auth.mcpOAuth?.[key]) return false;
  delete auth.mcpOAuth[key];
  await saveAuthFile(auth);
  return true;
}

export async function getApiKey(source: string): Promise<string | undefined> {
  const auth = await readAuthFile();
  return auth.apiKeys?.[source];
}

export async function saveApiKey(source: string, apiKey: string): Promise<void> {
  const auth = await readAuthFile();
  auth.apiKeys ??= {};
  auth.apiKeys[source] = apiKey;
  await saveAuthFile(auth);
}
