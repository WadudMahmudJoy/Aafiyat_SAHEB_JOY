import Link from "next/link";
import type { AdminCatalogue, AdminProductDetail } from "@/lib/admin-catalog";
import { catalogueHref, formatCataloguePrice } from "@/lib/admin-catalog-format";
import styles from "./catalogue.module.css";

export function CatalogueError({ message = "The catalogue is temporarily unavailable. Please retry." }: { message?: string }) {
  return <section className={styles.error} role="alert"><h1>Catalogue unavailable</h1><p>{message}</p><Link prefetch={false} className={styles.link} href="/admin/products">Reload catalogue</Link> · <Link prefetch={false} className={styles.link} href="/admin">Back to overview</Link></section>;
}

export function CatalogueView({ catalogue }: { catalogue: AdminCatalogue }) {
  if (catalogue.error) return <CatalogueError message={catalogue.error} />;
  return <section aria-labelledby="catalogue-heading">
    <header className={styles.heading}><p className={styles.eyebrow}>PRODUCTS AND INVENTORY · READ-ONLY</p><h1 id="catalogue-heading">Product catalogue</h1><p className={styles.intro}>Review every lifecycle stage. Product editing, stock adjustments, and media management are upcoming.</p></header>
    <form action="/admin/products" method="get" className={styles.filters}>
      <div className={styles.field}><label htmlFor="product-search">Search name or slug</label><input id="product-search" name="search" type="search" maxLength={100} defaultValue={catalogue.filters.search} /></div>
      <div className={styles.field}><label htmlFor="product-category">Category</label><select id="product-category" name="category" defaultValue={catalogue.filters.category}><option value="">All categories</option>{catalogue.filters.category && !catalogue.categories.some(category => category.id === catalogue.filters.category) && <option value={catalogue.filters.category}>Selected category unavailable</option>}{catalogue.categories.map(category => <option key={category.id} value={category.id}>{category.name}{category.active ? "" : " (inactive)"}</option>)}</select></div>
      <button className={styles.button} type="submit">Apply filters</button><Link prefetch={false} className={styles.link} href="/admin/products">Clear</Link>
    </form>
    {catalogue.categoriesTruncated && <p className={styles.note}>The first 100 categories are shown in the filter.</p>}
    {catalogue.items.length ? <div className={styles.scroll} role="region" aria-label="Scrollable product catalogue" tabIndex={0}><table className={styles.table}><caption>Products on this page. Prices and availability describe the first variant, not the whole product.</caption><thead><tr><th scope="col">Product</th><th scope="col">Category</th><th scope="col">Status</th><th scope="col">Variants / example price</th>{catalogue.canViewInventory && <th scope="col">Available · first variant</th>}</tr></thead><tbody>{catalogue.items.map(product => <tr key={product.id}>
      <td><Link prefetch={false} href={`/admin/products/${product.id}`}>{product.name}</Link><small>{product.slug}</small></td><td>{product.category.name}{!product.category.active && <small>Inactive category</small>}</td><td><span className={styles.status}>{product.lifecycle}</span></td>
      <td>{product.variantCount} {product.variantCount === 1 ? "variant" : "variants"}{product.exampleVariant ? <><small>{formatCataloguePrice(product.exampleVariant.priceMinor, product.exampleVariant.currency)}</small><small>{product.exampleVariant.sku} · {product.exampleVariant.active ? "Active" : "Inactive"}</small></> : <small>No variant price available</small>}</td>
      {catalogue.canViewInventory && <td>{product.exampleVariant ? product.exampleVariant.inventory ? product.exampleVariant.inventory.available : "No inventory balance" : "No variants"}</td>}
    </tr>)}</tbody></table></div> : <div className={styles.empty} role="status"><h2>No products found</h2><p>{catalogue.filters.search || catalogue.filters.category ? "Try clearing or changing the filters." : "No products have been added. Product creation is upcoming."}</p></div>}
    <div className={styles.pagination}><Link prefetch={false} className={styles.link} href={catalogueHref(catalogue.filters)}>First page</Link><p>{catalogue.items.length} {catalogue.items.length === 1 ? "product" : "products"} shown</p>{catalogue.nextCursor && <Link prefetch={false} className={styles.link} href={catalogueHref(catalogue.filters, catalogue.nextCursor)}>Next page →</Link>}</div>
    {!catalogue.canViewInventory && <p className={styles.note}>Exact inventory quantities require the existing inventory permission.</p>}
  </section>;
}

export function ProductDetailView({ detail }: { detail: AdminProductDetail }) {
  if (detail.error) return <CatalogueError message={detail.error} />;
  const product = detail.product;
  if (!product) return null;
  return <section aria-labelledby="product-heading"><Link prefetch={false} className={styles.link} href="/admin/products">← Product catalogue</Link><header className={styles.heading}><p className={styles.eyebrow}>PRODUCT INFORMATION · READ-ONLY</p><h1 id="product-heading">{product.name}</h1><span className={styles.status}>{product.lifecycle}</span></header>
    <div className={styles.facts}><section><h2>Product information</h2><dl><dt>Category</dt><dd>{product.category.name}{!product.category.active && " (inactive)"}</dd><dt>Slug</dt><dd>{product.slug}</dd><dt>Created (UTC)</dt><dd>{product.createdAt}</dd><dt>Updated (UTC)</dt><dd>{product.updatedAt}</dd><dt>Archived (UTC)</dt><dd>{product.archivedAt ?? "Not archived"}</dd></dl><p className={styles.description}>{product.description || "No description supplied."}</p></section>
      <section><h2>Search metadata</h2><dl><dt>SEO title</dt><dd>{product.seoTitle ?? "Not supplied"}</dd><dt>SEO description</dt><dd>{product.seoDescription ?? "Not supplied"}</dd></dl><p className={styles.note}>Editing and media management are upcoming.</p></section></div>
    <h2 className={styles.sectionTitle}>Product variants</h2><p className={styles.note}>{product.variantCount} {product.variantCount === 1 ? "variant" : "variants"} total. Active, inactive, and archived variants are included.</p>
    {detail.variants.length ? <div className={styles.scroll} role="region" aria-label="Scrollable variants and inventory" tabIndex={0}><table className={styles.table}><caption>Variant information{detail.canViewInventory ? " and inventory balances" : ""}</caption><thead><tr><th scope="col">SKU</th><th scope="col">Size / color</th><th scope="col">Price</th><th scope="col">Variant status</th>{detail.canViewInventory && <th scope="col">Inventory</th>}</tr></thead><tbody>{detail.variants.map(variant => <tr key={variant.id}><td>{variant.sku}</td><td>{variant.sizeLabel} / {variant.colorLabel}<small>{variant.sizeCode} / {variant.colorCode}</small></td><td>{formatCataloguePrice(variant.priceMinor, variant.currency)}</td><td>{variant.archivedAt ? "Archived" : variant.active ? "Active" : "Inactive"}</td>{detail.canViewInventory && <td>{variant.inventory ? <>On hand: {variant.inventory.onHand}<br />Reserved: {variant.inventory.reserved}<br />Available: {variant.inventory.available}<small>Low-stock threshold: {variant.inventory.lowStockThreshold ?? "Not configured"}</small></> : "No balance — unavailable"}</td>}</tr>)}</tbody></table></div> : <p className={styles.empty}>No variants on this page.</p>}
    <div className={styles.pagination}><Link prefetch={false} className={styles.link} href={`/admin/products/${product.id}`}>First variant page</Link>{detail.nextCursor && <Link prefetch={false} className={styles.link} href={`/admin/products/${product.id}?cursor=${detail.nextCursor}`}>Next variants →</Link>}</div>
    <h2 className={styles.sectionTitle}>Inventory information</h2><p className={styles.note}>{detail.canViewInventory ? "Available = on hand − reserved. Missing balances mean unavailable. Global low-stock settings are pending; stock adjustments are upcoming." : "Inventory quantities are restricted by server permissions."}</p>
  </section>;
}
