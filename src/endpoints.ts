/**
 * Where the model lives — and what that changes about what the plugin asks you.
 *
 * One question only, but it decides whether a form demands something that does
 * not exist: a base URL on this machine (or on the local network) needs **no**
 * API key. LM Studio, Ollama and llama.cpp all ignore the `Authorization`
 * header, and the original Python scripts got round that by inventing a dummy
 * key (`lm-studio`, `ollama`) just to satisfy a setting.
 *
 * The interesting half is what this does *not* do: it only removes the
 * requirement. A key that is stored is still sent, so a private server that does
 * authenticate keeps working, and nothing has to guess.
 *
 * Pure on purpose — no Obsidian import — so the addresses it accepts and refuses
 * are covered by tests (`test/endpoints.test.ts`).
 */

/** The host of a URL: `http://127.0.0.1:8080/v1` → `127.0.0.1`. */
export function hostnameOf(url: string): string | null {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url.trim());
  const authority = match?.[1];
  if (authority === undefined) return null;
  // An IPv6 literal arrives in brackets, and a port may follow it.
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    return end < 0 ? null : authority.slice(1, end).toLowerCase();
  }
  const host = authority.split('@').pop()?.split(':')[0] ?? '';
  return host.toLowerCase() || null;
}

/**
 * Ranges that cannot be reached from the internet: what a home server uses, and
 * the loopback. All three are anchored on purpose — a prefix test let
 * `127.0.0.1.example.com`, an ordinary public name, pass as local, which would
 * have meant not sending a key to a server that expects one.
 */
const PRIVATE_V4 =
  /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;

/**
 * Whether an endpoint is on this machine or the local network. It is the same
 * judgement a person makes by reading the address, so it is allowed to be this
 * simple: the worst a mistake costs is a request sent without a key to a server
 * that ignores keys anyway.
 */
export function isLocalEndpoint(baseUrl: string): boolean {
  const host = hostnameOf(baseUrl);
  if (host === null) return false;
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true;
  if (host.endsWith('.local')) return true;
  return PRIVATE_V4.test(host);
}
