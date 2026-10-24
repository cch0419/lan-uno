const colorOrder = { red: 0, yellow: 1, green: 2, blue: 3 };
const kindOrder = { number: 0, skip: 10, reverse: 11, draw2: 12, wild: 13, wild4: 14 };

/** Sort a copy only. The server hand and physical card IDs never change. */
export function sortHand(cards) {
  return [...cards].sort((a, b) => (colorOrder[a.color] ?? 4) - (colorOrder[b.color] ?? 4) ||
    (a.kind === 'number' ? a.value : kindOrder[a.kind]) - (b.kind === 'number' ? b.value : kindOrder[b.kind]) ||
    a.id.localeCompare(b.id, 'en', { numeric: true }));
}

/** Preserve a readable left corner; overflow becomes balanced fan rows. */
export function fanHandLayout(count, width, cardWidth, cardHeight) {
  if (!count) return { rows: 0, height: 0, positions: [] };
  const available = Math.max(cardWidth, width - 40);
  const maxPerRow = Math.max(1, Math.floor((available - cardWidth) / 24) + 1);
  const rows = Math.ceil(count / maxPerRow);
  const baseSize = Math.floor(count / rows);
  const extra = count % rows;
  const positions = [];
  for (let row = 0; row < rows; row++) {
    const size = baseSize + (row < extra ? 1 : 0);
    const step = size > 1 ? Math.min(cardWidth + 12, (available - cardWidth) / (size - 1)) : 0;
    const start = (width - (cardWidth + step * (size - 1))) / 2;
    for (let i = 0; i < size; i++) {
      const spread = size > 1 ? (i / (size - 1) - .5) * 2 : 0;
      positions.push({ x: start + i * step, y: row * (cardHeight + 36) + 14 + spread ** 2 * 14,
        angle: spread * 9, row, zIndex: i + 1 });
    }
  }
  return { rows, height: rows * (cardHeight + 36) + 4, positions };
}
