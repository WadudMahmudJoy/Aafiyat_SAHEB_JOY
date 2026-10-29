"use client";
import { useActionState,useState,useRef,useContext,type ReactNode } from "react";
import { catalogAction,type ControlState } from "./control-actions";
import styles from "../inventory/inventory.module.css";
import { ControlFeedbackContext } from "./control-feedback";
export default function ControlForm({children,fields,label,upload=false}:{children:ReactNode;fields:Record<string,string>;label:string;upload?:boolean}){
 const attempt=useRef<FormData|null>(null);const notify=useContext(ControlFeedbackContext);
 const [original]=useState(fields);const [file,setFile]=useState<File|null>(null);
 const [state,action,pending]=useActionState(async(previous:ControlState,data:FormData)=>{if(previous.uncertain&&attempt.current)data=attempt.current;if(upload&&file&&!((data.get("file") as File|null)?.size))data.set("file",file);attempt.current=data;try{const result=await catalogAction(previous,data);if(result.saved)notify(result.message);return result;}catch{return {message:"Response interrupted. Retry this exact request; the original file and fields are retained.",uncertain:true};}},{message:""});
 return <form action={action} aria-busy={pending} className={styles.form}>{Object.entries(original).map(([k,v])=><input key={k} type="hidden" name={k} value={v}/>)}<fieldset disabled={pending||state.saved||state.uncertain} className="catalogControlFields">{children}{upload&&<div className={styles.field}><label>Image file (PNG, JPEG or WebP; maximum 8 MiB)<input type="file" name="file" accept="image/png,image/jpeg,image/webp" required onChange={e=>setFile(e.target.files?.[0]??null)}/></label></div>}</fieldset>{state.message&&<div className={styles.message} role={state.saved?"status":"alert"}>{state.message}<p><a href={typeof original.productId==="string"?`/admin/products/${original.productId}/media`:"/admin/categories"}>Reload current state before a new operation</a></p></div>}{!state.saved&&<button className={styles.button} disabled={pending}>{pending?upload?"Uploading and verifying…":"Saving…":state.uncertain?"Retry same request":label}</button>}</form>;
}
