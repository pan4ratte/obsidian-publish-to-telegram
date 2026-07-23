import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseLinkComponents, linksMatch } from '../src/split';

test('parses a supergroup/channel private link and marks it -100', () => {
  assert.deepStrictEqual(
    parseLinkComponents('https://t.me/c/1234567890/5'),
    { chatId: '-1001234567890', messageId: 5, topicId: undefined },
  );
});

test('parses a basic (legacy) group link, keeping the bare "-<id>" marked id', () => {
  // Regression: a basic group is marked "-<id>" (no -100). Its link keeps the sign in the
  // /c/ segment; parsing must NOT prepend -100 or the edit would target the wrong peer.
  assert.deepStrictEqual(
    parseLinkComponents('https://t.me/c/-123456789/5'),
    { chatId: '-123456789', messageId: 5, topicId: undefined },
  );
});

test('parses a forum-topic supergroup link', () => {
  assert.deepStrictEqual(
    parseLinkComponents('https://t.me/c/1234567890/12/5'),
    { chatId: '-1001234567890', messageId: 5, topicId: 12 },
  );
});

test('parses a public username link', () => {
  assert.deepStrictEqual(
    parseLinkComponents('https://t.me/mychannel/5'),
    { chatId: '@mychannel', messageId: 5, topicId: undefined },
  );
});

test('accepts the bare t.me form written into split markers', () => {
  assert.deepStrictEqual(
    parseLinkComponents('t.me/c/-123456789/5'),
    { chatId: '-123456789', messageId: 5, topicId: undefined },
  );
});

test('basic-group links match regardless of the https prefix', () => {
  assert.ok(linksMatch('https://t.me/c/-123456789/5', 't.me/c/-123456789/5'));
  assert.ok(!linksMatch('https://t.me/c/-123456789/5', 'https://t.me/c/-123456789/6'));
});
