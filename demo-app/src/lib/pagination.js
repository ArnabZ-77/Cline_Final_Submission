// pagination.js       BUG 05 off-by-one
export function paginate(items, page, pageSize) {
  const start = page * pageSize;
  const end = start + pageSize - 1; // BUG: should be start + pageSize
  return items.slice(start, end);
}
