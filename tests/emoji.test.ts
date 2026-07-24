import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { emojiSections, searchEmoji, searchCustomEmoji, customEmojiRef, parseCustomEmojiRef } from '../src/emoji-search';
import { EMOJI_SECTION_DATA } from '../src/emoji-data';
import { mdToTelegramHtml, mdToBotApiHtml, obsidianToRichMarkdown, hasCustomEmoji } from '../src/markdown';
import { CustomEmojiSet } from '../src/types';

const sections = emojiSections();
const all = sections.flatMap(section => section.entries);
const found = (query: string, limit = 200) => searchEmoji(query, limit).map(entry => entry.emoji);

test('ships the full standard emoji set in Telegram Desktop\'s panel sections', () => {
  assert.deepStrictEqual(
    sections.map(section => section.key),
    ['people', 'nature', 'food', 'activity', 'travel', 'objects', 'symbols'],
  );
  // The whole fully-qualified Unicode set minus skin-tone variants — a few thousand, not
  // the couple of hundred that Telegram's emoji-category API returns.
  assert.ok(all.length > 1800, `expected the full set, got ${all.length}`);
  for (const section of sections) assert.ok(section.entries.length > 50, `${section.key} looks short`);
});

test('every entry parses into emoji, name and keywords, with no duplicates', () => {
  for (const entry of all) {
    assert.ok(entry.emoji.length > 0);
    assert.ok(entry.name.length > 0, `no name for ${entry.emoji}`);
    assert.ok(entry.words.length > 0, `no search words for ${entry.emoji}`);
    assert.ok(!entry.emoji.includes('|'), `unparsed line for ${entry.emoji}`);
  }
  assert.equal(new Set(all.map(entry => entry.emoji)).size, all.length, 'duplicate emoji across sections');
  // Skin-tone variants are deliberately left out (the panel has no tone selector).
  assert.equal(EMOJI_SECTION_DATA.some(section => section.entries.includes('skin tone')), false);
});

test('finds emoji by English name and by Russian keyword alike', () => {
  assert.ok(found('cat').includes('🐱'));
  assert.ok(found('кот').includes('🐱'));
  assert.ok(found('pizza').includes('🍕'));
  assert.ok(found('пицца').includes('🍕'));
  assert.ok(found('flag').includes('🏳️'));
  assert.ok(found('флаг').includes('🏳️'));
});

test('matches a shared stem, so "smile" finds "smiling face"', () => {
  // Regression: plain substring matching missed these — "smile" is not inside "smiling".
  assert.ok(found('smile').includes('😊'));
  assert.ok(found('улыб').includes('😀'));
  assert.ok(found('путеше').length > 0);
});

test('ranks exact word hits above mid-word matches', () => {
  const cats = found('cat');
  // The cats themselves lead (Telegram's own order among equal hits); "identification
  // card", which merely contains "cat" inside a word, has to come after all of them.
  assert.ok(cats.slice(0, 12).includes('🐱'));
  assert.ok(cats.indexOf('🐈') < cats.indexOf('🪪'));
});

test('requires every word of a multi-word query to match', () => {
  assert.ok(found('red heart').includes('❤️'));
  assert.equal(found('red heart zzz').length, 0);
});

test('an empty or whitespace query returns nothing, and results respect the limit', () => {
  assert.deepStrictEqual(searchEmoji(''), []);
  assert.deepStrictEqual(searchEmoji('   '), []);
  assert.equal(searchEmoji('a', 10).length, 10);
});

// ─── Custom emoji (Premium) ───────────────────────────────────────────────────

const packs: CustomEmojiSet[] = [{
  id: '1',
  title: 'Cat pack',
  entries: [{ id: '5368324170671202286', alt: '👍' }, { id: '5370870893004203424', alt: '🐱' }],
}];

test('writes and reads back the note syntax for a custom emoji', () => {
  const ref = customEmojiRef('👍', '5368324170671202286');
  assert.equal(ref, '[👍](tg://emoji?id=5368324170671202286)');
  assert.deepStrictEqual(parseCustomEmojiRef(ref), { alt: '👍', id: '5368324170671202286' });
  assert.equal(parseCustomEmojiRef('👍'), null);
  assert.equal(parseCustomEmojiRef('[👍](https://example.com)'), null);
  assert.equal(hasCustomEmoji(`text ${ref} more`), true);
  assert.equal(hasCustomEmoji('text [link](https://example.com)'), false);
});

test('finds custom emoji through their fallback emoji, in both languages', () => {
  assert.deepStrictEqual(searchCustomEmoji(packs, 'thumbs up').map(hit => hit.id), ['5368324170671202286']);
  assert.deepStrictEqual(searchCustomEmoji(packs, 'палец').map(hit => hit.id), ['5368324170671202286']);
  assert.deepStrictEqual(searchCustomEmoji(packs, 'cat').map(hit => hit.alt), ['👍', '🐱']); // pack name matches too
  assert.deepStrictEqual(searchCustomEmoji(packs, 'zzzz'), []);
  assert.deepStrictEqual(searchCustomEmoji([], 'cat'), []);
});

test('publishes a custom emoji as a <tg-emoji> entity through every method', () => {
  const note = `Hi ${customEmojiRef('👍', '5368324170671202286')}!`;
  const expected = 'Hi <tg-emoji emoji-id="5368324170671202286">👍</tg-emoji>!';
  // Account (mtcute HTML), bot (Bot API HTML) and Rich Messages all take this tag.
  assert.equal(mdToTelegramHtml(note), expected);
  assert.equal(mdToBotApiHtml(note), expected);
  assert.equal(obsidianToRichMarkdown(note), expected);
});

test('leaves ordinary links alone', () => {
  assert.equal(
    mdToTelegramHtml('[text](https://example.com)'),
    '<a href="https://example.com">text</a>',
  );
});
