/**
 * Google Sheets access for a service account, using only Web Crypto and fetch
 * so it runs in the carrier runtime without dependencies.
 */

type ServiceAccount = {
  client_email: string;
  private_key: string;
  private_key_id?: string;
};

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const encodeJson = (value: unknown): string =>
  toBase64Url(new TextEncoder().encode(JSON.stringify(value)));

const pemToDer = (pem: string): Uint8Array<ArrayBuffer> => {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
};

const signJwt = async (account: ServiceAccount): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(account.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = encodeJson({ alg: "RS256", typ: "JWT", kid: account.private_key_id });
  const claims = encodeJson({
    iss: account.client_email,
    sub: account.client_email,
    aud: TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + 3600,
    scope: SCOPE,
  });
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  return `${header}.${claims}.${toBase64Url(new Uint8Array(signature))}`;
};

let cachedToken: { token: string; expiresAt: number } | null = null;

export const accessToken = async (serviceAccountJson: string): Promise<string> => {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;

  const account = JSON.parse(serviceAccountJson) as ServiceAccount;
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: await signJwt(account),
    }),
  });
  if (!response.ok) throw new Error(`Google auth failed: ${await response.text()}`);

  const payload = (await response.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: payload.access_token, expiresAt: Date.now() + payload.expires_in * 1000 };
  return cachedToken.token;
};

export type SheetsClient = <T = unknown>(
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
) => Promise<T>;

/** A client bound to one spreadsheet; `path` is appended to `/v4/spreadsheets/<id>`. */
export const sheetsClient = (token: string, spreadsheetId: string): SheetsClient =>
  async (method, path, body) => {
    const response = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}${path}`,
      {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: body === undefined ? null : JSON.stringify(body),
      },
    );
    if (!response.ok) {
      throw new Error(`Sheets ${method} ${path} → ${response.status}: ${await response.text()}`);
    }
    return response.json();
  };
