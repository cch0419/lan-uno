/** Keep cards readable: overflow horizontally instead of shrinking the hand. */
export function layoutHand(count, viewportWidth, cardWidth = 83, cardHeight = 119) {
  if (!count) return { width: viewportWidth, height: 0, cards: [] };
  const side = 38;
  const available = Math.max(0, viewportWidth - side * 2 - cardWidth);
  const minStep = Math.max(48, cardWidth * 0.65);
  const maxStep = count <= 3 ? cardWidth + 10 : cardWidth * 0.9;
  const step = count === 1 ? 0 : Math.max(minStep, Math.min(maxStep, available / (count - 1)));
  const spread = cardWidth + step * (count - 1);
  const width = Math.max(viewportWidth, spread + side * 2);
  const overflowing = width > viewportWidth + 1;
  // A long hand has a shallower arc, so its edges remain easy to read.
  const angle = Math.min(14, (count - 1) * 2.3) * (overflowing ? 0.65 : 1);
  const rise = Math.min(24, (count - 1) * 4) * (overflowing ? 0.7 : 1);
  return {
    width, height: cardHeight + rise + 52, overflowing,
    cards: Array.from({ length: count }, (_, index) => {
      const offset = count === 1 ? 0 : (index / (count - 1)) * 2 - 1;
      return { x: (width - spread) / 2 + index * step, y: 28 + rise * offset ** 2, angle: angle * offset };
    })
  };
}
