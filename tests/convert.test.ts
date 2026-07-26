import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mdToTelegramHtml, obsidianToRichMarkdown } from '../src/markdown';

// `expect(x).toBe(y)` over node:assert, so the ported test bodies stay unchanged.
function expect(received: unknown) {
  return {
    toBe(expected: unknown) {
      assert.strictEqual(received, expected);
    },
  };
}

// Test cases for markdown to Telegram HTML conversion

test('Text', () => {
  const markdown = 'Hello world!';
  const expected = 'Hello world!';
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Escaped text', () => {
  const markdown = 'Simple t`ext 2 + 2 * (32 / 32) = 4';
  const expected = 'Simple t`ext 2 + 2 * (32 / 32) = 4';
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Headings', () => {
  const markdown = '# heading 1\n## heading 2\n### heading 3';
  const expected = '<b>heading 1</b>\n\n<b>heading 2</b>\n\n<b>heading 3</b>';
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Bold', () => {
  const markdown = '**bold text**';
  const expected = `<b>bold text</b>`;
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Bold character in word', () => {
  expect(mdToTelegramHtml('he**l**lo')).toBe(`he<b>l</b>lo`);
});

test('Italic', () => {
  const markdown = '*italic text*';
  const expected = `<i>italic text</i>`;
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Bold+Italic', () => {
  const markdown = '***bold+italic***';
  const expected = `<i><b>bold+italic</b></i>`;
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Strike', () => {
  const markdown = '~~strike text~~';
  const expected = `<s>strike text</s>`;
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Unordered list', () => {
  const markdown = '* list\n* list\n* list';
  const expected = '• list\n• list\n• list';
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Unordered list with + marker', () => {
  const markdown = '+ list\n+ list\n+ list';
  const expected = '• list\n• list\n• list';
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Unordered list with - marker', () => {
  const markdown = '- list\n- list\n- list';
  const expected = '• list\n• list\n• list';
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Unordered list with mixed markers', () => {
  const markdown = '* list\n* list\n+ list';
  const expected = '• list\n• list\n• list';
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Unordered list with mixed markers separated by blank line', () => {
  const markdown = '* list\n* list\n\n+ list\n+ list';
  const expected = '• list\n• list\n\n• list\n• list';
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Ordered list', () => {
  const markdown = '1. list\n2. list\n3. list';
  const expected = '1. list\n2. list\n3. list';
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Ordered list with ) marker', () => {
  const markdown = '1) list\n2) list\n3) list';
  const expected = '1) list\n2) list\n3) list';
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Ordered list with mixed ) and . markers', () => {
  const markdown = '1) list\n2) list\n3. list';
  const expected = '1) list\n2) list\n\n3. list';
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Link with alt', () => {
  const markdown = '[t.e.s+t](http://atlassian.com)';
  const expected = '<a href="http://atlassian.com">t.e.s+t</a>';
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Link with parentheses', () => {
  const markdown = '[Apple](https://en.wikipedia.org/wiki/Apple_(disambiguation))';
  const expected = '<a href="https://en.wikipedia.org/wiki/Apple_(disambiguation)">Apple</a>';
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Inline code', () => {
  const markdown = 'hello `world`';
  const expected = 'hello <code>world</code>';
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Code block', () => {
  const markdown = '```\ncode block\n```';
  const expected = '<pre>code block</pre>';
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Code block with language', () => {
  const markdown = '```javascript\ncode block\n```';
  const expected = '<pre>code block</pre>';
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('HTML Comment', () => {
  const markdown = '<!-- Comment -->';
  const expected = '';
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Bold text in lists', () => {
  const markdown =
    '- To make text **bold**, surround it with double asterisks (`**`): `**This text is bold.**`';
  const expected =
    '• To make text <b>bold</b>, surround it with double asterisks (<code>**</code>): <code>**This text is bold.**</code>';
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Code after list', () => {
  const markdown = `1. Foo:\n\n\`\`\`\nBar\n\`\`\``;
  const expected = `1. Foo:\n\n<pre>Bar</pre>`;
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Multiple code blocks and lists', () => {
  const markdown = `1. Foo:\n\n\`\`\`\nBar\n\`\`\`\n\n2. Baz:\n\n\`\`\`\nQux\n\`\`\``;
  const expected = `1. Foo:\n\n<pre>Bar</pre>\n\n2. Baz:\n\n<pre>Qux</pre>`;
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Telegram V2: Special character escaping', () => {
  const markdown = 'Test with {braces} and |pipes| and =equals=';
  const expected = 'Test with {braces} and |pipes| and =equals=';
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Blockquote preserves line breaks', () => {
  const markdown = `> line one
> line two
>
> line after break`;
  const expected = `<blockquote>line one\nline two\n\nline after break</blockquote>`;
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Blockquote with paragraphs preserves breaks', () => {
  const markdown = `> first paragraph
>
> second paragraph`;
  const expected = `<blockquote>first paragraph\n\nsecond paragraph</blockquote>`;
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Underline support with HTML <u> tags', () => {
  const markdown = 'This is <u>underlined</u> text';
  const expected = 'This is <u>underlined</u> text';
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Spoiler support with HTML <span> tags', () => {
  const markdown = 'This is <spoiler>spoiler</spoiler> text';
  const expected = 'This is <spoiler>spoiler</spoiler> text';
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Combined underline and spoiler', () => {
  const markdown =
    'Text with <u>underline</u> and <spoiler>spoiler</spoiler>';
  const expected = 'Text with <u>underline</u> and <spoiler>spoiler</spoiler>';
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Nested formatting with underline', () => {
  const markdown = '<u>**bold underline**</u>';
  const expected = '<u><b>bold underline</b></u>';
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('User mention links', () => {
  const markdown = '[John Doe](tg://user?id=123456)';
  const expected = '<a href="tg://user?id=123456">John Doe</a>';
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Escaping in V2 features', () => {
  const markdown = '<u>under_line_test</u>';
  const expected = '<u>under_line_test</u>';
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Complex nesting with all V2 features', () => {
  const markdown = '***<u><spoiler>nested</spoiler></u>***';
  const expected = '<i><b><u><spoiler>nested</spoiler></u></b></i>';
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Thematic break with ---', () => {
  const markdown = 'before\n\n---\n\nafter';
  const expected = 'before\n\n───\n\nafter';
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Thematic break with *****', () => {
  const markdown = 'before\n\n*****\n\nafter';
  const expected = 'before\n\n─────\n\nafter';
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Thematic break with ___', () => {
  const markdown = 'before\n\n___\n\nafter';
  const expected = 'before\n\n───\n\nafter';
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

test('Mixed-level headings, blockquotes, and inline formatting', () => {
  const markdown = `### Aristotle

> Aristotle was a student of [Plato](https://example.com/plato) and tutored Alexander the Great for several years.

> His work on _Poetics_ studies the nature of writing and poetry in great detail.
# Legacy

His ideas shaped Western thought for centuries.
### Legacy

His writings remain a cornerstone of Western philosophy.`;
  const expected = `<b>Aristotle</b>

<blockquote>Aristotle was a student of <a href="https://example.com/plato">Plato</a> and tutored Alexander the Great for several years.</blockquote>

<blockquote>His work on <i>Poetics</i> studies the nature of writing and poetry in great detail.</blockquote>

<b>Legacy</b>

His ideas shaped Western thought for centuries.

<b>Legacy</b>

His writings remain a cornerstone of Western philosophy.`;
  expect(mdToTelegramHtml(markdown)).toBe(expected);
});

// Rich Messages render empty lines. Telegram drops a bare blank line (it's a block separator,
// and blocks render flush), so every blank line past the first \u2014 the one the paragraph break is
// written with \u2014 comes back as a block holding a non-breaking space: N blank lines render as
// N-1 empty lines.
const NBSP = '\u00A0';

test('Rich: one blank line is the paragraph break, and adds no empty line', () => {
  const markdown = 'first\n\nsecond';
  expect(obsidianToRichMarkdown(markdown)).toBe('first\n\nsecond');
});

test('Rich: two blank lines make one empty line', () => {
  const markdown = 'first\n\n\nsecond';
  expect(obsidianToRichMarkdown(markdown)).toBe(`first\n\n${NBSP}\n\nsecond`);
});

test('Rich: every blank line past the first makes an empty line', () => {
  const markdown = 'first\n\n\n\n\nsecond';
  expect(obsidianToRichMarkdown(markdown)).toBe(`first\n\n${NBSP}\n\n${NBSP}\n\n${NBSP}\n\nsecond`);
});

test('Rich: a line of nothing but whitespace counts as a blank line', () => {
  const markdown = 'first\n \t\n\nsecond';
  expect(obsidianToRichMarkdown(markdown)).toBe(`first\n\n${NBSP}\n\nsecond`);
});

test('Rich: blank lines around the message are dropped, not filled', () => {
  const markdown = '\n  \nfirst line\n\n\nlast\n \n\n';
  expect(obsidianToRichMarkdown(markdown)).toBe(`first line\n\n${NBSP}\n\nlast`);
});

test('Rich: a blank line inside fenced code stays blank', () => {
  const markdown = '```\ncode\n\nstill code\n```';
  expect(obsidianToRichMarkdown(markdown)).toBe('```\ncode\n\nstill code\n```');
});

test('Rich: nothing is injected inside a container block', () => {
  const markdown = '<tg-collage>\n\n![](https://x/a.jpg)\n![](https://x/b.jpg)\n\n</tg-collage>';
  expect(obsidianToRichMarkdown(markdown)).toBe(markdown);
});

test('Classic HTML still collapses the blank lines its own conversion introduces', () => {
  const markdown = 'first\n\n\n\nsecond';
  expect(mdToTelegramHtml(markdown)).toBe('first\n\nsecond');
});
