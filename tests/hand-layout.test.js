import test from 'node:test';
import assert from 'node:assert/strict';
import { sortHand, fanHandLayout } from '../public/hand-layout.js';
import { buildDeck } from '../server/game.js';

test('hand sorting groups colors, numbers ascending, then actions and black cards without mutation', () => {
  const cards = [
    { id: 'c9', color: null, kind: 'wild4' }, { id: 'c8', color: 'blue', kind: 'number', value: 0 },
    { id: 'c7', color: 'red', kind: 'draw2' }, { id: 'c6', color: 'red', kind: 'number', value: 9 },
    { id: 'c5', color: 'red', kind: 'number', value: 1 }, { id: 'c4', color: 'yellow', kind: 'number', value: 2 },
    { id: 'c3', color: 'green', kind: 'number', value: 3 }, { id: 'c2', color: null, kind: 'wild' }
  ];
  const before = structuredClone(cards);
  assert.deepEqual(sortHand(cards).map(c => c.id), ['c5', 'c6', 'c7', 'c4', 'c3', 'c8', 'c2', 'c9']);
  assert.deepEqual(cards, before);
  const pack = buildDeck().reverse();
  assert.deepEqual(new Set(sortHand(pack).map(c => c.id)), new Set(pack.map(c => c.id)));
  assert.deepEqual(sortHand(sortHand(pack)), sortHand(pack));
});

test('fan rows keep visible number corners instead of scrolling or crushing a large hand', () => {
  for (const width of [280, 350, 900]) {
    for (const count of [1, 3, 7, 15, 30, 80]) {
      const layout = fanHandLayout(count, width, 73, 105);
      assert.equal(layout.positions.length, count);
      assert.ok(layout.positions.every(p => p.x >= 19 && p.x + 73 <= width - 19 && p.y + 105 <= layout.height));
      for (let row = 0; row < layout.rows; row++) {
        const cards = layout.positions.filter(p => p.row === row);
        for (let i = 1; i < cards.length; i++) assert.ok(cards[i].x - cards[i - 1].x >= 23.99);
      }
    }
  }
  assert.ok(fanHandLayout(20, 350, 73, 105).rows > 1);
  assert.equal(fanHandLayout(3, 350, 73, 105).rows, 1);
  assert.equal(fanHandLayout(0, 350, 73, 105).height, 0);
});
