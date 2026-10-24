import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutHand } from '../public/hand-layout.js';

test('small hands form a centered symmetric fan with a flat single card', () => {
  assert.deepEqual(layoutHand(0, 390).cards, []);
  const single = layoutHand(1, 390, 73, 105);
  assert.equal(single.cards[0].angle, 0);
  assert.equal(single.cards[0].x + 73 / 2, 195);
  for (const count of [2, 3, 7]) {
    const fan = layoutHand(count, 1000);
    for (let i = 0; i < count; i++) {
      const opposite = fan.cards[count - 1 - i];
      assert.ok(Math.abs(fan.cards[i].angle + opposite.angle) < 1e-8);
      assert.ok(Math.abs(fan.cards[i].y - opposite.y) < 1e-8);
    }
    assert.ok(fan.cards[0].y >= fan.cards[Math.floor(count / 2)].y);
  }
});

test('large hands preserve readable exposed edges and overflow instead of shrinking', () => {
  for (const viewport of [280, 320, 390, 768, 1440]) {
    for (const count of [1, 2, 7, 14, 30, 108]) {
      const fan = layoutHand(count, viewport, 73, 105);
      assert.equal(fan.cards.length, count);
      assert.ok(fan.width >= viewport);
      for (let i = 1; i < count; i++) assert.ok(fan.cards[i].x - fan.cards[i - 1].x >= 48 - 1e-8);
      for (const card of fan.cards) {
        assert.ok(card.x >= 37.99);
        assert.ok(card.x + 73 <= fan.width - 37.99);
        assert.ok(Math.abs(card.angle) <= 14);
        assert.ok(card.y + 105 + 20 <= fan.height);
      }
    }
  }
  assert.equal(layoutHand(30, 390, 73, 105).overflowing, true);
  assert.equal(layoutHand(7, 1000).overflowing, false);
});
