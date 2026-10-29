import { randomUUID } from "node:crypto";
import Link from "next/link";
import type { readBusiness } from "@/lib/admin-business";
import BusinessForm from "./business-form";
import styles from "./inventory/inventory.module.css";
import businessStyles from "./business.module.css";
type Data=Awaited<ReturnType<typeof readBusiness>>;
const money=(n:string)=>{const x=BigInt(n);return (x/BigInt(100)).toString()+"."+(x%BigInt(100)).toString().padStart(2,"0");};
function OfferFields({offer}:{offer?:Data["offers"][number]}){return <>
 <input type="hidden" name="id" value={offer?.id??randomUUID()}/><input type="hidden" name="version" value={offer?.version??"0"}/>
 <label>Name<input name="name" required maxLength={120} defaultValue={offer?.name}/></label>
 <label>Coupon code (optional)<input name="coupon" maxLength={40} defaultValue={offer?.coupon_code??""}/></label>
 <label>Discount type<select name="kind" defaultValue={offer?.kind??"fixed"}><option value="fixed">Fixed BDT</option><option value="percentage">Percentage</option></select></label>
 <label>Discount value (BDT or percent)<input name="value" inputMode="decimal" required defaultValue={offer?money(offer.value):""}/></label>
 <label>Start (UTC)<input name="startsAt" type="datetime-local" step="1" required defaultValue={offer?.starts_at.slice(0,19)}/></label>
 <label>End (UTC; exclusive)<input name="endsAt" type="datetime-local" step="1" required defaultValue={offer?.ends_at.slice(0,19)}/></label>
 <label>Administrative status<select name="active" defaultValue={String(offer?.active??false)}><option value="false">Inactive / draft</option><option value="true">Active configuration</option></select></label></>;}
export default function BusinessView({data,mode}:{data:Data;mode:"settings"|"offers"}){
 if(!data.available)return <section className={styles.empty}><h1>{mode==="settings"?"Business settings":"Marketing offers"}</h1><p>This module awaits separately authorized database migration deployment. No save is available.</p></section>;
 const s=data.settings;
 return <section className={businessStyles.workspace}><header className={styles.heading}><h1>{mode==="settings"?"Business settings":"Marketing offers"}</h1><Link href="/admin">Admin overview</Link></header>
 {mode==="settings"&&s?<><section className={styles.panel}><h2>Shipping, stock and consent</h2><p>BDT only. Free shipping requires post-discount merchandise subtotal strictly greater than the threshold. Shipping charges and zones remain unconfigured.</p><BusinessForm mode="settings"><input type="hidden" name="version" value={s.version}/><label>Free-shipping threshold (BDT)<input name="threshold" inputMode="decimal" required defaultValue={money(s.free_shipping_threshold_minor)}/></label><label>Default low-stock threshold (blank: no default)<input name="lowStock" inputMode="numeric" defaultValue={s.low_stock_threshold??""}/></label><label>Promotional consent UI<select name="consentVisible" defaultValue={String(s.consent_visible)}><option value="false">Hidden</option><option value="true">Visible</option></select></label><label>Consent notice<textarea name="consentNotice" maxLength={1000} defaultValue={s.consent_notice}/></label><p>Notice version: {s.consent_version}. Visibility or wording never grants consent or sends messages.</p></BusinessForm></section><section className={styles.panel}><h2>Policy and integration status</h2><p>Exchange: three days; start event unresolved. No automatic eligibility calculation.</p><p>Reviews: disabled and hidden in V1.</p><p>SSLCOMMERZ: no verified gateway integration or payment flow enabled.</p><p>Object storage: {data.storage?"Configuration fields present; connectivity not established by this page.":"Unconfigured."}</p></section></>:<>
 <p>These are order-level configurations. Checkout redemption and offer precedence are not implemented. Active does not mean redeemable by customers.</p>
 <section className={styles.panel}><h2>Create offer</h2><BusinessForm mode="offers"><OfferFields/></BusinessForm></section>
 {data.offers.map(o=><section className={styles.panel} key={o.id}><h2>{o.name}</h2><p>{o.active?"Active configuration":"Inactive / draft"} · Revision {o.version}</p><BusinessForm mode="offers"><OfferFields offer={o}/></BusinessForm></section>)}
 {!data.offers.length&&<p>No offers configured.</p>}<nav><Link href="/admin/marketing/offers">First page</Link>{data.nextCursor&&<Link href={"/admin/marketing/offers?cursor="+data.nextCursor}>Next offers</Link>}</nav></>}
 <section className={styles.panel}><h2>Recent change history</h2><p>Latest twenty authorized changes; summaries contain versions and changed categories, not credentials or customer details.</p><ul>{data.audit.map(a=><li key={a.id}>{a.at} · {a.action} · {a.entity_id} · {JSON.stringify(a.summary)}</li>)}</ul>{!data.audit.length&&<p>No changes recorded.</p>}</section></section>;
}
