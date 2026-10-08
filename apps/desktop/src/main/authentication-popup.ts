const AUTH_PROVIDER_HOSTS = new Set([
  "auth.openai.com",
  "auth0.openai.com",
  "login.openai.com",
  "accounts.openai.com",
  "accounts.google.com",
  "login.microsoftonline.com",
  "appleid.apple.com",
  "idmsa.apple.com",
]);

export function allowedAuthenticationPopupUrl(
  value: string,
  baseUrl: string,
): boolean {
  let url: URL;
  let base: URL;
  try {
    url = new URL(value);
    base = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.origin === base.origin) return true;
  return url.protocol === "https:" && AUTH_PROVIDER_HOSTS.has(url.hostname);
}
