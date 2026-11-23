'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseWikiImages, pageFromLink } = require('../src/main/wikiImages');

const IMG = (key, w, alt, src = `https://static.wikia.nocookie.net/escapefromtarkov_gamepedia/images/a/a1/${key}/revision/latest/scale-to-width-down/${w}?cb=1`) =>
  `<img alt="${alt}" src="${src}" decoding="async" width="${w}" height="200" data-image-name="${key}" data-image-key="${key}">`;

test('wiki pictures: content shots with captions, no banner, icons or lazy-load stubs', () => {
  const html = [
    IMG('BadRepEvidenceQuestPicture.png', 314, 'BadRepEvidenceQuestPicture'),
    IMG('Bad_Rep_Evidence_Customs.png', 300, 'Bunkhouse location marked on map'),
    IMG('GoldenTTIcon.png', 127, 'GoldenTTIcon'),
    IMG('Docs_0031_location.png', 300, 'The secure folder on the table'),
    IMG('Docs_0031_location.png', 300, 'The secure folder on the table'), // same picture twice
    '<img src="data:image/gif;base64,R0lGOD" data-src="https://static.wikia.nocookie.net/x/a/b/Lazy_shot.jpg/revision/latest/scale-to-width-down/300?cb=2" width="300" data-image-key="Lazy_shot.jpg" alt="Lazy_shot">',
    IMG('Prapor_Portrait.png', 300, 'Prapor'),
  ].join('\n');
  const imgs = parseWikiImages(html);
  assert.deepStrictEqual(
    imgs.map((i) => i.caption),
    ['Bunkhouse location marked on map', 'The secure folder on the table', ''],
  );
  assert.ok(imgs[0].thumb.includes('scale-to-width-down/300'));
  assert.ok(!imgs[0].full.includes('scale-to-width-down'));
  assert.ok(imgs[0].full.endsWith('/revision/latest?cb=1'));
  assert.ok(imgs[2].thumb.includes('Lazy_shot.jpg'), 'lazy-loaded pictures use data-src');
});

test('wiki page names come only from links to the Tarkov wiki', () => {
  assert.strictEqual(pageFromLink('https://escapefromtarkov.fandom.com/wiki/The_Huntsman_Path_-_Trophy'), 'The_Huntsman_Path_-_Trophy');
  assert.strictEqual(pageFromLink('https://escapefromtarkov.fandom.com/wiki/Gunsmith_-_Part_1%3F'), 'Gunsmith_-_Part_1?');
  assert.strictEqual(pageFromLink('https://example.com/wiki/Bad_Rep_Evidence'), null);
  assert.strictEqual(pageFromLink('not a url'), null);
});
