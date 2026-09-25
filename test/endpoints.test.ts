/**
 * Local-endpoint tests. Run with: npm test
 *
 * The case that matters is the one that prompted this: a model served by
 * llama.cpp on this machine answers perfectly well and has no key to give, so
 * demanding one is a form asking for something that does not exist. The refusals
 * matter just as much — a mistake in the other direction would quietly stop
 * sending the key to a provider that needs it.
 */
import assert from 'node:assert/strict';
import { hostnameOf, isLocalEndpoint } from '../src/endpoints';

let failed = 0;
let total = 0;

function check(label: string, got: unknown, expected: unknown): void {
  total++;
  try {
    assert.deepStrictEqual(got, expected);
    console.log(`  ok   ${label}`);
  } catch {
    failed++;
    console.error(
      `  FAIL ${label}\n       got      ${JSON.stringify(got)}\n       expected ${JSON.stringify(expected)}`,
    );
  }
}

// --- reading the host out of a URL -----------------------------------------
check('a plain URL gives up its host', hostnameOf('http://127.0.0.1:8080/v1'), '127.0.0.1');
check('a bare host works too', hostnameOf('http://localhost:1234/v1'), 'localhost');
check('case is not the point', hostnameOf('HTTPS://OpenRouter.AI/api/v1'), 'openrouter.ai');
check('a user and password are skipped', hostnameOf('http://user:pass@10.0.0.5:8080/v1'), '10.0.0.5');
check('an IPv6 literal is unwrapped', hostnameOf('http://[::1]:8080/v1'), '::1');
check('a URL with no scheme has no host', hostnameOf('localhost:8080'), null);
check('and neither does nonsense', hostnameOf('no soy una url'), null);

// --- what counts as local ---------------------------------------------------
check('the loopback address the user runs', isLocalEndpoint('http://127.0.0.1:8080/v1'), true);
check('localhost', isLocalEndpoint('http://localhost:11434/v1'), true);
check('IPv6 loopback', isLocalEndpoint('http://[::1]:8080/v1'), true);
check('a .local name', isLocalEndpoint('http://mac-mini.local:8080/v1'), true);
check('another loopback address', isLocalEndpoint('http://127.0.0.2:8080/v1'), true);
check('a home-network address', isLocalEndpoint('http://192.168.68.101:8080/v1'), true);
check('a private 10.x address', isLocalEndpoint('http://10.1.2.3:8080/v1'), true);
check('a private 172.16-31 address', isLocalEndpoint('http://172.20.0.4:8080/v1'), true);

check('Gemini is not local', isLocalEndpoint('https://generativelanguage.googleapis.com'), false);
check('nor is OpenRouter', isLocalEndpoint('https://openrouter.ai/api/v1'), false);
check('nor a public address that looks similar', isLocalEndpoint('http://172.32.0.1:8080/v1'), false);
check('nor a public 192 address', isLocalEndpoint('http://192.169.0.1:8080/v1'), false);
check('a host named after a loopback is still remote', isLocalEndpoint('http://127.0.0.1.example.com/v1'), false);
check('and an empty setting is not local', isLocalEndpoint(''), false);

if (failed > 0) {
  console.error(`\n${failed} of ${total} endpoint checks failed.`);
  process.exit(1);
}
console.log('\nendpoint checks passed.');
