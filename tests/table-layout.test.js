import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutSeats } from '../public/table-layout.js';

test('every player sees themselves at bottom while relative seat order stays consistent', () => {
  for (let count = 2; count <= 10; count++) {
    const ids = Array.from({ length: count }, (_, i) => `p${i}`);
    for (const viewer of ids) {
      const seats = layoutSeats(ids, viewer);
      assert.equal(seats[0].id, viewer);
      assert.equal(seats[0].x, 50);
      assert.equal(seats[0].y, 93);
      const anchor = ids.indexOf(viewer);
      for (const [index, seat] of seats.entries()) {
        assert.equal(seat.id, ids[(anchor + index) % count]);
        assert.ok(seat.x >= 8.49 && seat.x <= 91.51);
        assert.ok(seat.y >= 7 && seat.y <= 93);
      }
      assert.equal(new Set(seats.map(seat => `${seat.x},${seat.y}`)).size, count);
    }
  }
});

test('spectators see actual seats only; no fake player is created', () => {
  assert.deepEqual(layoutSeats(['A', 'B'], 'host').map(seat => seat.id), ['A', 'B']);
  assert.deepEqual(layoutSeats([], 'host'), []);
});
