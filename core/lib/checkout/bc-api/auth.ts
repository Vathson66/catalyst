/**
 * BigCommerce Management API credentials.
 * All values are server-side only — never exposed to the browser.
 */
function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function bcManagementBase(): string {
  return `https://api.bigcommerce.com/stores/${requireEnv('BC_STORE_HASH')}/v3`;
}

export function bcManagementHeaders(): Record<string, string> {
  return {
    'X-Auth-Token': requireEnv('BC_MANAGEMENT_TOKEN'),
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}
