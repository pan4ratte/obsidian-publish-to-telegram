import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseProxyLink, isValidMtProxySecret, proxyCarriesBots, defaultProxyPort } from '../src/proxy-link';

const SECRET = '0123456789abcdef0123456789abcdef';
// "ee" + 16-byte secret + "google.com" in hex — a fake-TLS secret
const FAKE_TLS = 'ee' + SECRET + '676f6f676c652e636f6d';

test('parses tg://proxy MTProxy links', () => {
  assert.deepEqual(
    parseProxyLink(`tg://proxy?server=mt.example.com&port=443&secret=${FAKE_TLS}`),
    { type: 'mtproto', host: 'mt.example.com', port: 443, secret: FAKE_TLS },
  );
});

test('parses t.me/proxy links with or without a scheme', () => {
  const expected = { type: 'mtproto', host: '1.2.3.4', port: 8443, secret: 'dd' + SECRET };
  assert.deepEqual(parseProxyLink(`https://t.me/proxy?server=1.2.3.4&port=8443&secret=dd${SECRET}`), expected);
  assert.deepEqual(parseProxyLink(`t.me/proxy?server=1.2.3.4&port=8443&secret=dd${SECRET}`), expected);
  assert.deepEqual(parseProxyLink(`https://telegram.me/proxy?server=1.2.3.4&port=8443&secret=dd${SECRET}`), expected);
});

test('rejects MTProxy links missing a part', () => {
  assert.equal(parseProxyLink('tg://proxy?server=1.2.3.4&port=443'), null);
  assert.equal(parseProxyLink(`tg://proxy?port=443&secret=${SECRET}`), null);
  assert.equal(parseProxyLink(`tg://proxy?server=1.2.3.4&port=99999&secret=${SECRET}`), null);
});

test('parses tg://socks and t.me/socks links, login optional', () => {
  assert.deepEqual(
    parseProxyLink('tg://socks?server=1.2.3.4&port=1080&user=bob&pass=s3cret'),
    { type: 'socks5', host: '1.2.3.4', port: 1080, username: 'bob', secret: 's3cret' },
  );
  assert.deepEqual(
    parseProxyLink('https://t.me/socks?server=1.2.3.4&port=1080'),
    { type: 'socks5', host: '1.2.3.4', port: 1080, username: undefined, secret: undefined },
  );
});

test('parses proxy URLs by scheme, decoding the login', () => {
  assert.deepEqual(
    parseProxyLink('socks5://us%20er:p%40ss@127.0.0.1:10808'),
    { type: 'socks5', host: '127.0.0.1', port: 10808, username: 'us er', secret: 'p@ss' },
  );
  assert.deepEqual(parseProxyLink('socks5h://proxy.local:2080')?.type, 'socks5');
  assert.deepEqual(
    parseProxyLink('http://10.0.0.1:3128'),
    { type: 'http', host: '10.0.0.1', port: 3128, username: undefined, secret: undefined },
  );
  assert.equal(parseProxyLink('https://proxy.example.com')?.port, 443);
  assert.equal(parseProxyLink('http://proxy.example.com')?.port, 80);
  assert.equal(parseProxyLink('socks5://[::1]:1080')?.host, '::1');
});

test('parses the bare formats proxy sellers hand out, leaving the type open', () => {
  assert.deepEqual(
    parseProxyLink('45.12.1.2:8000:login:pa:ss'),
    { host: '45.12.1.2', port: 8000, username: 'login', secret: 'pa:ss' },
  );
  assert.deepEqual(
    parseProxyLink('login:pass@45.12.1.2:8000'),
    { host: '45.12.1.2', port: 8000, username: 'login', secret: 'pass' },
  );
  assert.deepEqual(parseProxyLink('  45.12.1.2:8000 '), { host: '45.12.1.2', port: 8000 });
});

test('returns null for text that is not a proxy', () => {
  for (const input of ['', 'hello world', 'ftp://1.2.3.4:21', '1.2.3.4', '1.2.3.4:0', 'socks4://1.2.3.4:1080']) {
    assert.equal(parseProxyLink(input), null, input);
  }
});

test('validates MTProxy secrets in every accepted form', () => {
  assert.ok(isValidMtProxySecret(SECRET));
  assert.ok(isValidMtProxySecret('dd' + SECRET));
  assert.ok(isValidMtProxySecret(FAKE_TLS));
  assert.ok(isValidMtProxySecret(FAKE_TLS.toUpperCase()));
  // the same fake-TLS secret as url-safe base64, the way some bots share it
  const b64 = Buffer.from(FAKE_TLS, 'hex').toString('base64url');
  assert.ok(isValidMtProxySecret(b64));
});

test('rejects malformed MTProxy secrets', () => {
  assert.ok(!isValidMtProxySecret(''));
  assert.ok(!isValidMtProxySecret(SECRET.slice(0, 30)));      // too short
  assert.ok(!isValidMtProxySecret('ab' + SECRET));            // 17 bytes without dd
  assert.ok(!isValidMtProxySecret('dd' + SECRET + 'ff'));     // 18 bytes that aren't ee
  assert.ok(!isValidMtProxySecret(SECRET + '0'));             // odd hex
  assert.ok(!isValidMtProxySecret('not a secret!'));
});

test('only generic tunnels carry bots', () => {
  assert.equal(proxyCarriesBots('mtproto'), false);
  assert.equal(proxyCarriesBots('socks5'), true);
  assert.equal(proxyCarriesBots('http'), true);
  assert.equal(proxyCarriesBots('https'), true);
  assert.equal(defaultProxyPort('socks5'), 1080);
});
