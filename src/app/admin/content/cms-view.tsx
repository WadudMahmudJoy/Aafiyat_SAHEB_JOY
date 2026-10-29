import Link from "next/link";
import { randomUUID } from "node:crypto";
import type { readCms } from "@/lib/admin-cms";
import type { CmsKind } from "@/lib/cms-validation";
import CmsForm,{MeasurementEditor} from "./cms-form";
import ProductCover from "../products/product-cover";
import styles from "../inventory/inventory.module.css";
import businessStyles from "../business.module.css";
type Data=Awaited<ReturnType<typeof readCms>>;type Entry=Data["entries"][number];
function Fields({entry,kinds,data}:{entry?:Entry;kinds:CmsKind[];data:Data}){
 return <><input type="hidden" name="id" value={entry?.id??randomUUID()}/><input type="hidden" name="version" value={entry?.version??"0"}/>
 <label>Content type<select aria-label="Content type" name="kind" defaultValue={entry?.kind??kinds[0]}>{(entry?[entry.kind]:kinds).map(k=><option key={k} value={k}>{k}</option>)}</select></label>
 <label>Key / slug (hero must use homepage-hero)<input name="slug" required maxLength={100} defaultValue={entry?.slug??(kinds[0]==="hero"?"homepage-hero":"")}/></label>
 <label>Title / headline<input name="title" required maxLength={160} defaultValue={entry?.title}/></label>
 <label>Subtitle<input name="subtitle" maxLength={500} defaultValue={entry?.subtitle??""}/></label>
 <label>Body / editorial text<textarea name="body" maxLength={10000} defaultValue={entry?.body??""}/></label>
 <label>CTA label<input name="ctaLabel" maxLength={60} defaultValue={entry?.ctaLabel??""}/></label>
 <label>CTA internal destination<input name="ctaUrl" maxLength={180} placeholder="/products" defaultValue={entry?.ctaUrl??""}/></label>
 <label>SEO title<input name="seoTitle" maxLength={70} defaultValue={entry?.seoTitle??""}/></label><label>SEO description<textarea name="seoDescription" maxLength={160} defaultValue={entry?.seoDescription??""}/></label>
 <label>Visibility<select aria-label="Visibility" name="visible" defaultValue={String(entry?.visible??false)}><option value="false">Hidden</option><option value="true">Visible when published</option></select></label>
 <label>Publication state<select aria-label="Publication state" name="state" defaultValue={entry?.state??"draft"}><option value="draft">Draft / unpublish</option><option value="published">Published</option></select></label>
 <label>Display order (lower first)<input name="order" inputMode="numeric" required defaultValue={entry?.sortOrder??0}/></label>
 <label>Ordered featured product IDs (comma separated)<input name="products" defaultValue={entry?.references.flatMap(x=>x.productId?[x.productId]:[]).join(",")??""}/></label>
 <label>Ordered category IDs (comma separated)<input name="categories" defaultValue={entry?.references.flatMap(x=>x.categoryId?[x.categoryId]:[]).join(",")??""}/></label>
 <details><summary>Available reference choices (first 100 eligible records)</summary><p>Copy the required IDs into the ordered fields above. Size guides require a category or explicit product association.</p><ul>{data.products.map(p=><li key={p.id}>{p.name}: {p.id}</li>)}{data.categories.map(c=><li key={c.id}>{c.name}: {c.id}</li>)}</ul></details>
 {kinds[0]==="size-guide"?<MeasurementEditor initial={entry?.measurements}/>:<input type="hidden" name="table" value=""/>}
 </>;
}
export default function CmsView({data,kinds,title}:{data:Data;kinds:CmsKind[];title:string}){return <section className={businessStyles.workspace}><header className={styles.heading}><h1>{title}</h1><nav><Link href="/admin/content/homepage">Homepage</Link><Link href="/admin/content/pages">Pages</Link><Link href="/admin/content/size-guides">Size guides</Link></nav></header>{!data.available?<p>The CMS schema awaits separately authorized deployment.</p>:<>
 <section className={styles.panel}><h2>Create draft content</h2><p>Use only approved text and measurements. Save a draft before uploading an image. Hero and banner publication requires a verified image.</p><CmsForm operation="save"><Fields kinds={kinds} data={data}/></CmsForm></section>
 {data.entries.map(e=><section className={styles.panel} key={e.id}><h2>{e.title}</h2><p>{e.kind} · {e.state} · Revision {e.version}</p><ProductCover key={e.coverId??"missing"} image={e.coverId?{url:"/api/admin/content-media/"+e.coverId,altText:e.title}:undefined}/><CmsForm operation="save"><Fields entry={e} kinds={kinds} data={data}/></CmsForm><details><summary>Stored content preview</summary><h3>{e.title}</h3><p>{e.subtitle}</p><p style={{whiteSpace:"pre-wrap"}}>{e.body}</p>{e.measurements&&<pre style={{whiteSpace:"pre-wrap"}}>{JSON.stringify(e.measurements,null,2)}</pre>}</details>
 {data.storage?<CmsForm operation="upload"><input type="hidden" name="entryId" value={e.id}/><input type="hidden" name="version" value={e.version}/><input type="hidden" name="idempotencyKey" value={randomUUID()}/><label>Content image (PNG, JPEG, WebP; maximum 8 MiB)<input name="file" type="file" accept="image/png,image/jpeg,image/webp" required/></label></CmsForm>:<p>Storage unconfigured; upload unavailable.</p>}
 {e.coverId&&e.state==="draft"&&<CmsForm operation="remove"><input type="hidden" name="entryId" value={e.id}/><input type="hidden" name="version" value={e.version}/></CmsForm>}
 </section>)}
 {!data.entries.length&&<p>No content entries yet.</p>}<nav><a href="">Reload current data</a>{data.nextCursor&&<Link href={"?cursor="+data.nextCursor}>Next page</Link>}</nav></>}</section>;}
