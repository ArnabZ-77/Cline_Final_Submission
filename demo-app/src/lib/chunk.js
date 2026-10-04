// chunk.js            BUG 06 off-by-one
export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size + 1) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
