"use client";
import { useActionState,useState,type ReactNode } from "react";
import { saveBusiness } from "./business-actions";
import { minorUnits } from "@/lib/business-rules";
import styles from "./inventory/inventory.module.css";
export default function BusinessForm({mode,children}:{mode:"settings"|"offers";children:ReactNode}){
 const [preview,setPreview]=useState("");
 const [state,action,pending]=useActionState(saveBusiness.bind(null,mode),{ok:false,message:""});
 return <form className={styles.form} action={data=>{for(const key of ["startsAt","endsAt"]){const value=data.get(key);if(typeof value==="string"&&value&&!value.endsWith("Z")){const date=new Date(value+"Z");if(Number.isFinite(date.getTime()))data.set(key,date.toISOString());}}action(data);}} onChange={e=>{if(mode!=="offers")return;try{const f=new FormData(e.currentTarget);const v=minorUnits(f.get("value")),s=minorUnits((e.currentTarget.elements.namedItem("previewSubtotal") as HTMLInputElement)?.value??"1000");const d=f.get("kind")==="fixed"?v:s*v/BigInt(10000);const n=d>s?s:d;setPreview("BDT "+(n/BigInt(100)).toString()+"."+(n%BigInt(100)).toString().padStart(2,"0"));}catch{setPreview("Enter valid amounts to preview.");}}}>
 <fieldset disabled={pending||state.ok} style={{border:0,padding:0,minWidth:0,display:"grid",gap:12}}>{children}{mode==="offers"&&<p>Preview for BDT 1,000 merchandise subtotal: <output>{preview||"Enter a discount."}</output>. Administrative preview only.</p>}</fieldset>
 {state.message&&<p role={state.ok?"status":"alert"}>{state.message} <a href={mode==="settings"?"/admin/settings":"/admin/marketing/offers"}>Reload current data</a></p>}
 <button className={styles.button} disabled={pending||state.ok}>{pending?"Saving…":"Save"}</button></form>;
}
