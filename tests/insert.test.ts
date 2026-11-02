import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseMapInput, isShortMapLink, mapToHtml, mapCheckUrl } from '../src/map-link';
import {
  captionedEmbed, mediaGroup, mathMarkdown, referenceName, referenceNames, nextReferenceName,
  referenceLink, referenceText,
} from '../src/insert-syntax';
import { postEndAt } from '../src/split';
import { rewriteEmbeds, obsidianToRichMarkdown } from '../src/markdown';

test('Map: plain coordinates, with degrees and hemispheres', () => {
  assert.deepEqual(parseMapInput('41.9028, 12.4964'), { lat: 41.9028, long: 12.4964 });
  assert.deepEqual(parseMapInput('41.9028 12.4964'), { lat: 41.9028, long: 12.4964 });
  assert.deepEqual(parseMapInput('-33.8688;151.2093'), { lat: -33.8688, long: 151.2093 });
  assert.deepEqual(parseMapInput('33.8688° S, 151.2093° E'), { lat: -33.8688, long: 151.2093 });
  assert.deepEqual(parseMapInput('12.4964° E, 41.9028° N'), { lat: 41.9028, long: 12.4964 });
  assert.equal(parseMapInput('95, 10'), null);
  assert.equal(parseMapInput('hello'), null);
});

test('Map: Google Maps links', () => {
  assert.deepEqual(parseMapInput('https://www.google.com/maps/@41.9028,12.4964,15z'), { lat: 41.9028, long: 12.4964, zoom: 15 });
  assert.deepEqual(
    parseMapInput('https://www.google.com/maps/place/Colosseum/@41.8902,12.4922,17.5z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d41.8902102!4d12.4922309'),
    { lat: 41.8902102, long: 12.4922309, zoom: 18 },
  );
  assert.deepEqual(parseMapInput('https://maps.google.com/?q=41.9,12.5&z=12'), { lat: 41.9, long: 12.5, zoom: 12 });
  assert.equal(parseMapInput('https://www.google.com/maps/place/Rome'), null);
});

test('Map: Yandex, 2GIS, OpenStreetMap, Apple, Bing and geo: links', () => {
  assert.deepEqual(parseMapInput('https://yandex.ru/maps/?ll=37.617635%2C55.755814&z=12'), { lat: 55.755814, long: 37.617635, zoom: 12 });
  assert.deepEqual(parseMapInput('https://yandex.ru/maps/?ll=37.6,55.7&pt=37.62,55.75&z=16'), { lat: 55.75, long: 37.62, zoom: 16 });
  assert.deepEqual(parseMapInput('https://2gis.ru/moscow?m=37.62%2C55.75%2F16'), { lat: 55.75, long: 37.62, zoom: 16 });
  assert.deepEqual(parseMapInput('https://2gis.ru/moscow/geo/4504235282647283/37.62,55.75'), { lat: 55.75, long: 37.62 });
  assert.deepEqual(parseMapInput('https://www.openstreetmap.org/#map=14/41.9/12.5'), { lat: 41.9, long: 12.5, zoom: 14 });
  assert.deepEqual(parseMapInput('https://www.openstreetmap.org/?mlat=41.89&mlon=12.49#map=17/41.9/12.5'), { lat: 41.89, long: 12.49, zoom: 17 });
  assert.deepEqual(parseMapInput('https://maps.apple.com/?ll=41.9,12.5&z=10'), { lat: 41.9, long: 12.5, zoom: 10 });
  assert.deepEqual(parseMapInput('https://www.bing.com/maps?cp=41.9~12.5&lvl=11'), { lat: 41.9, long: 12.5, zoom: 11 });
  assert.deepEqual(parseMapInput('geo:41.9,12.5?z=30'), { lat: 41.9, long: 12.5, zoom: 24 });
});

test('Map: short links are recognised, not read', () => {
  assert.ok(isShortMapLink('https://maps.app.goo.gl/abc123'));
  assert.ok(isShortMapLink('https://yandex.ru/maps/-/CDabc'));
  assert.ok(isShortMapLink('https://go.2gis.com/xyz'));
  assert.ok(!isShortMapLink('https://www.google.com/maps/@41.9,12.5,15z'));
});

test('Map: the tag, with and without a caption', () => {
  assert.equal(mapToHtml({ lat: 41.9028, long: 12.4964, zoom: 14 }), '<tg-map lat="41.9028" long="12.4964" zoom="14"/>');
  assert.equal(mapToHtml({ lat: 41.123456789, long: -0.5 }), '<tg-map lat="41.123457" long="-0.5" zoom="15"/>');
  assert.equal(
    mapToHtml({ lat: 41.9, long: 12.5, zoom: 14 }, ' Rome '),
    '<figure><tg-map lat="41.9" long="12.5" zoom="14"/><figcaption>Rome</figcaption></figure>',
  );
  assert.equal(mapCheckUrl({ lat: 41.9, long: 12.5, zoom: 14 }), 'https://www.openstreetmap.org/?mlat=41.9&mlon=12.5#map=14/41.9/12.5');
});

test('Media: captioned embeds keep the target one token', () => {
  assert.equal(captionedEmbed('Фото кота (1).jpg', 'Мой "кот"'), '![](Фото%20кота%20%281%29.jpg "Мой &quot;кот&quot;")');
  assert.equal(captionedEmbed('100%.png', 'A'), '![](100%25.png "A")');
  assert.equal(captionedEmbed('https://example.com/a%20b.jpg', 'Cap (c)'), '![](https://example.com/a%20b.jpg "Cap (c)")');
});

test('Media: collages and slideshows hold Markdown media and a figcaption', () => {
  assert.equal(mediaGroup('collage', ['![[a.jpg]]', '![](https://x.com/b.mp4)'], ''),
    '<tg-collage>\n\n![[a.jpg]]\n![](https://x.com/b.mp4)\n\n</tg-collage>');
  assert.equal(mediaGroup('slideshow', ['![[a.jpg]]', '![[b.jpg]]'], 'Trip'),
    '<tg-slideshow>\n\n![[a.jpg]]\n![[b.jpg]]\n\n<figcaption>Trip</figcaption>\n\n</tg-slideshow>');
});

test('Media: a local caption survives the rewrite to an uploaded attachment', () => {
  const out = rewriteEmbeds('![](Фото%20кота%20%281%29.jpg "Cap (1)") ![[b.png]] ![](c.png)', () => '![](tg://photo?id=m0)');
  assert.equal(out, '![](tg://photo?id=m0 "Cap (1)") ![](tg://photo?id=m0) ![](tg://photo?id=m0)');
  assert.equal(obsidianToRichMarkdown('![](tg://photo?id=m0 "Cap (1)")'), '![](tg://photo?id=m0 "Cap (1)")');
  assert.equal(obsidianToRichMarkdown('![](https://x.com/a.jpg "Cap (1)")'), '![](https://x.com/a.jpg "Cap (1)")');
});

test('Formula: inline and block, on one line', () => {
  assert.equal(mathMarkdown(' x^2 ', false), '$x^2$');
  assert.equal(mathMarkdown('a = b\n  + c', true), '$$a = b + c$$');
});

test('Reference: names, links and referenced text', () => {
  assert.equal(referenceName(' my note "1" '), 'my-note-1');
  const note = '<tg-reference name="note-1">A</tg-reference> <a name="chapter"></a> <a href="#note-1">x</a> <tg-reference name="note-1">B</tg-reference>';
  assert.deepEqual(referenceNames(note), ['note-1', 'chapter']);
  assert.equal(nextReferenceName(note), 'note-2');
  assert.equal(nextReferenceName(''), 'note-1');
  assert.equal(referenceLink('note-1', 'see'), '<a href="#note-1">see</a>');
  assert.equal(referenceText('note-1', 'text'), '<tg-reference name="note-1">text</tg-reference>');
});

test('Split: the end of the post around an offset', () => {
  const body = 'First post\n%% \\split %%\nSecond post\n%% \\split t.me/c/1/2 %%\nThird';
  const first = body.indexOf('%% \\split %%');
  const second = body.indexOf('%% \\split t.me');
  assert.equal(postEndAt(body, 0), first);
  assert.equal(postEndAt(body, body.indexOf('Second')), second);
  assert.equal(postEndAt(body, body.indexOf('Third')), body.length);
  assert.equal(postEndAt('No markers', 3), 10);
});
