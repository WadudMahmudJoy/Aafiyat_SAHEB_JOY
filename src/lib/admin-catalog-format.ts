export function formatCataloguePrice(priceMinor: string, currency: string) {
  const value = BigInt(priceMinor);
  return `${currency} ${new Intl.NumberFormat("en-BD").format(value / BigInt(100))}.${(value % BigInt(100)).toString().padStart(2, "0")}`;
}

export function catalogueHref(filters: { search: string; category: string }, cursor?: string | null) {
  const query = new URLSearchParams();
  if (filters.search) query.set("search", filters.search);
  if (filters.category) query.set("category", filters.category);
  if (cursor) query.set("cursor", cursor);
  return `/admin/products${query.size ? `?${query}` : ""}`;
}
