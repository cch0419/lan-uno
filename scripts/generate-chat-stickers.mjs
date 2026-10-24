import { mkdir, writeFile } from 'node:fs/promises';
import { stickers } from '../public/chat-catalog.js';

// Original vector card characters: entirely local, with no external images.
const faces = {
  laugh: '<path d="M47 65q7-12 14 0m20 0q7-12 14 0"/><path d="M49 82q23 31 45 0Z" fill="#fff6dc"/><path d="M58 95q14-10 28 0" stroke="#cf4c54"/>',
  shock: '<circle cx="54" cy="65" r="5" fill="#263b36"/><circle cx="88" cy="65" r="5" fill="#263b36"/><ellipse cx="71" cy="90" rx="10" ry="13" fill="#fff6dc"/><path d="M46 49l13-4m22 0 13 4"/>',
  cry: '<path d="M46 62l15 5m20 0 15-5M58 95q13-18 26 0"/><path d="M49 72q-13 21 0 21q13 0 0-21m44 0q-13 21 0 21q13 0 0-21" fill="#9bd8ee" stroke="none"/>',
  'draw-four': '<path d="M44 58l18 8m18 0 18-8M51 84q20 24 40 0"/><path d="M38 39l-6-17 21 10m37 0 21-10-6 17" fill="#cf4c54"/><text x="71" y="113" text-anchor="middle" font-size="18" fill="#fff6dc" stroke="none">+4</text>',
  thanks: '<path d="M44 61q10-17 19 0m17 0q10-17 19 0M57 86q14 17 28 0"/><ellipse cx="44" cy="77" rx="8" ry="4" fill="#ee9b92" stroke="none"/><ellipse cx="98" cy="77" rx="8" ry="4" fill="#ee9b92" stroke="none"/>',
  steady: '<path d="M40 60h64l-6 19H80l-8-13-9 13H46Z" fill="#263b36"/><path d="M50 62l7 7m25-7 7 7" stroke="#fff6dc" stroke-width="2"/><path d="M58 93q14 8 28-5"/>',
  nice: '<path d="M46 63q8-11 16 0m18 0q8-11 16 0M55 83q16 23 32 0"/><path d="M111 87v-15q11-8 9-18q10 1 8 18h9q8 0 5 10l-5 16h-26Z" fill="#f5d38b"/>',
  gg: '<path d="M48 63q7-8 14 0m18 0q7-8 14 0M58 85q14 14 28 0"/><path d="M48 30l-6-17 18 9 11-16 11 16 18-9-6 17Z" fill="#f0c557"/>'
};
const folder = new URL('../public/stickers/', import.meta.url);
await mkdir(folder, { recursive: true });
for (const [index, sticker] of stickers.entries()) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="168" height="160" viewBox="0 0 168 160" role="img" aria-label="${sticker.label}">
<title>${sticker.label}</title><rect width="168" height="160" rx="22" fill="#faf5e8"/><circle cx="84" cy="73" r="57" fill="${sticker.color}" opacity=".13"/>
<path d="M17 38l4 5 6-1-4 6 2 6-6-3-5 3 1-6-4-4 6-1Z" fill="${sticker.color}"/><path d="M139 32l4 7 8 1-6 5 1 8-7-4-7 4 2-8-6-5 8-1Z" fill="#eac263"/>
<ellipse cx="85" cy="125" rx="44" ry="7" fill="#263b36" opacity=".1"/>
<g transform="translate(12 5) rotate(${index % 2 ? 7 : -7} 71 72)" stroke="#263b36" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
<rect x="33" y="30" width="78" height="95" rx="13" fill="${sticker.color}" stroke="#fffdf4" stroke-width="5"/><ellipse cx="71" cy="76" rx="31" ry="35" fill="#fff6dc" opacity=".88" stroke="none"/>
${faces[sticker.id]}<path d="M36 100l-14 8m85-8 14 8"/></g>
<text x="84" y="148" text-anchor="middle" fill="#263b36" font-family="Microsoft YaHei, sans-serif" font-size="19" font-weight="900">${sticker.label}</text></svg>`;
  await writeFile(new URL(`${sticker.id}.svg`, folder), svg);
}
console.log(`Generated ${stickers.length} local chat stickers.`);
