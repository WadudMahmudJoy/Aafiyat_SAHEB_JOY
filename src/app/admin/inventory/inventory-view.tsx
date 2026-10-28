import Link from "next/link";
import { randomUUID } from "node:crypto";
import type { InventoryOverview, InventoryDetail, InventoryRow } from "@/lib/admin-inventory-read";
import StockForm from "./stock-form";
import styles from "./inventory.module.css";
export function StockStatus({ row }: { row: InventoryRow }) {
  const missing = row.onHand === null;
  const empty = !missing && row.available === 0;
  const low = !missing && !empty && row.threshold !== null && row.available! <= row.threshold;
  return <span className={`${styles.badge} ${empty ? styles.out : low ? styles.low : ""}`}>{missing ? "Not initialized" : empty ? "No available stock" : low ? "Low stock" : "In stock"}</span>;
}
export function InventoryError({ invalid = false }: { invalid?: boolean }) {
  return <section className={styles.empty} role="alert"><h1>Inventory unavailable</h1><p>{invalid ? "Check the search or page identifier and try again." : "We could not load inventory. No stock operation has been confirmed."}</p><Link href="/admin/inventory" className={styles.link}>Reload inventory</Link></section>;
}
export function InventoryOverviewView({ data }: { data: InventoryOverview }) {
  return <section><header className={styles.heading}><div><p className={styles.eyebrow}>STOCK CONTROL · PRIVATE ADMINISTRATION</p><h1>Inventory</h1><p className={styles.intro}>Review variant balances, receive deliveries and reconcile physical counts. Every adjustment has an immutable movement receipt.</p></div></header>
    <form action="/admin/inventory" method="get" className={styles.filters}><div className={styles.field}><label htmlFor="inventory-search">Search product, SKU, category or identifier</label><input id="inventory-search" type="search" name="search" maxLength={100} defaultValue={data.search} /></div><button className={styles.button}>Search inventory</button><Link href="/admin/inventory" className={styles.link}>Clear</Link></form>
    {data.items.length ? <div className={styles.tableWrap} role="region" aria-label="Variant inventory" tabIndex={0}><table className={styles.table}><caption>Up to 25 variants per page. Available stock = on hand − reserved.</caption><thead><tr><th>Product / variant</th><th>Status</th><th>On hand</th><th>Reserved</th><th>Available</th></tr></thead><tbody>{data.items.map(v => <tr key={v.variantId}><td><Link href={`/admin/inventory/${v.variantId}`}>{v.productName}</Link><small>{v.sku} · {v.sizeLabel} / {v.colorLabel}</small><small>{v.category}</small></td><td><StockStatus row={v} /><small>{v.lifecycle} · {v.archived ? "Archived variant" : v.active ? "Active variant" : "Inactive variant"}</small></td><td>{v.onHand ?? "—"}</td><td>{v.reserved ?? "—"}</td><td>{v.available ?? "—"}</td></tr>)}</tbody></table></div> : <p className={styles.empty}>{data.search ? "No variants match this search." : "No variants are available yet. Add a product variant to begin."}</p>}
    <nav className={styles.pagination} aria-label="Inventory pages"><Link className={styles.link} href={`/admin/inventory?search=${encodeURIComponent(data.search)}`}>First page</Link>{data.nextCursor && <Link className={styles.link} href={`/admin/inventory?search=${encodeURIComponent(data.search)}&cursor=${data.nextCursor}`}>Next variants →</Link>}</nav>
  </section>;
}
export function InventoryDetailView({ data }: { data: InventoryDetail }) {
  const v = data.variant;
  return <section><header className={styles.heading}><div><p className={styles.eyebrow}>VARIANT INVENTORY</p><h1>{v.productName}</h1><p className={styles.intro}>{v.sku} · {v.sizeLabel} / {v.colorLabel}</p></div><Link className={styles.link} href={`/admin/products/${v.productId}`}>View product →</Link></header>
    <div className={styles.metadata}><span>{v.category}</span><span>Product: {v.lifecycle}{v.productArchived ? " · archived" : ""}</span><span>Variant: {v.archived ? "archived" : v.active ? "active" : "inactive"}</span><StockStatus row={v} /></div>
    <div className={styles.stats}>{[["On hand", v.onHand], ["Reserved", v.reserved], ["Available", v.available]].map(([label, value]) => <div className={styles.stat} key={label}><span>{label}</span><strong>{value ?? "—"}</strong></div>)}</div>
    <p className={styles.note}>{v.onHand === null ? "No balance has been initialized. Receiving or a positive physical correction can initialize it." : `Low-stock threshold: ${v.threshold ?? "not configured"}. Available = on hand − reserved.`}</p>
    <p className={styles.revision}>Balance revision (UTC): {v.revision}</p>
    <div className={styles.forms}>{data.canReceive ? <StockForm operation="receive" productId={v.productId} variantId={v.variantId} revision={v.revision} idempotencyKey={randomUUID()} /> : <section className={styles.panel}><h2>Receiving unavailable</h2><p className={styles.note}>Receiving requires an unarchived draft or active product and an active, unarchived variant.</p></section>}
      {data.canCorrect ? <StockForm operation="correction" productId={v.productId} variantId={v.variantId} revision={v.revision} idempotencyKey={randomUUID()} /> : <section className={styles.panel}><h2>Correction unavailable</h2><p className={styles.note}>Archived products and variants cannot undergo physical stock correction.</p></section>}</div>
    <h2 className={styles.sectionTitle}>Stock movement history</h2><p className={styles.note}>Historical snapshots, newest first. These describe each movement, not current stock.</p>
    {data.movements.length ? <div className={styles.tableWrap} role="region" aria-label="Stock movement history" tabIndex={0}><table className={styles.table}><caption>Up to 20 receiving and correction movements per page. Dates are UTC.</caption><thead><tr><th>Operation / recorded at</th><th>On hand</th><th>Reserved</th><th>Actor / reason</th></tr></thead><tbody>{data.movements.map(m => <tr key={m.id}><td><span className={styles.badge}>{m.movementType}</span><small>{m.createdAt}</small><small className={styles.mono}>{m.id}</small></td><td>{m.onHandBefore} → {m.onHandAfter}<small>Delta {m.deltaOnHand > 0 ? "+" : ""}{m.deltaOnHand}</small></td><td>{m.reservedBefore} → {m.reservedAfter}</td><td>{m.actor}<div className={styles.historyReason}>{m.reason}</div></td></tr>)}</tbody></table></div> : <p className={styles.empty}>No movements on this page.</p>}
    <nav className={styles.pagination} aria-label="Movement history pages"><Link className={styles.link} href={`/admin/inventory/${v.variantId}`}>Latest movements</Link>{data.nextCursor && <Link className={styles.link} href={`/admin/inventory/${v.variantId}?cursor=${data.nextCursor}`}>Older movements →</Link>}</nav><Link href="/admin/inventory" className={styles.link}>← All inventory</Link>
  </section>;
}
