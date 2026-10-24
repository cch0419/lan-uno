/** Rotate the shared seating order so the viewing player always sits below.
 * Screen angles increase clockwise: from bottom, the next seat is on the left.
 * Spectators use the first actual player as the reference, without a fake seat.
 */
export function layoutSeats(seatOrder, viewerId) {
  if (!seatOrder.length) return [];
  const anchor = Math.max(0, seatOrder.indexOf(viewerId));
  const order = [...seatOrder.slice(anchor), ...seatOrder.slice(0, anchor)];
  return order.map((id, index) => {
    const angle = Math.PI / 2 + index * Math.PI * 2 / order.length;
    return { id, index, x: 50 + Math.cos(angle) * 41.5, y: 50 + Math.sin(angle) * 43 };
  });
}
