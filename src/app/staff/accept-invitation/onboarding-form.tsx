"use client";
import { useEffect,useState,type FormEvent } from "react";
import styles from "./onboarding.module.css";
type Result={ok:boolean;message:string;stage?:"verifying"|"mailbox_verified"|"provisioned"};
export default function OnboardingForm(){
  const [stage,setStage]=useState("entry"),[message,setMessage]=useState(""),[busy,setBusy]=useState(true);
  const [invitationId,setInvitationId]=useState(""),[secret,setSecret]=useState(""),[code,setCode]=useState(""),[password,setPassword]=useState(""),[confirmation,setConfirmation]=useState("");
  useEffect(()=>{let live=true;fetch("/api/staff/onboarding",{cache:"no-store",credentials:"same-origin",headers:{"x-staff-onboarding":"1"}}).then(r=>r.json()).then((r:Result)=>{if(live&&r.ok&&r.stage){setStage(r.stage);setMessage(r.message);}}).catch(()=>{}).finally(()=>{if(live)setBusy(false);});return()=>{live=false;};},[]);
  async function send(operation:string){
    if(busy)return;setBusy(true);setMessage("");
    try{const payload=operation==="start"?{operation,invitationId,secret}:operation==="verify"?{operation,code}:operation==="provision"?{operation,password,confirmation}:{operation};
      const response=await fetch("/api/staff/onboarding",{method:"POST",credentials:"same-origin",cache:"no-store",headers:{"content-type":"application/json","x-staff-onboarding":"1"},body:JSON.stringify(payload)});const result:Result=await response.json();
      setMessage(result.message);if(result.ok&&result.stage)setStage(result.stage);
    }catch{setMessage("Unable to continue. Try again or contact the inviting administrator.");}finally{setSecret("");setCode("");setPassword("");setConfirmation("");setBusy(false);}
  }
  function submit(e:FormEvent){e.preventDefault();void send(stage==="entry"?"start":stage==="mailbox_verified"?"provision":"verify");}
  return <main className={styles.page}><section className={styles.card} aria-busy={busy}><p className={styles.brand}>AAFIYAT SAHEB</p><h1>Staff invitation</h1>
    <p>Verify your invitation and mailbox, then prepare your inactive staff identity. This page grants no administration access.</p>
    {stage!=="provisioned"?<form onSubmit={submit}>
      <fieldset disabled={busy}>
      {stage==="entry"?<><label>Invitation reference<input name="invitationId" value={invitationId} onChange={e=>setInvitationId(e.target.value)} required maxLength={36} autoComplete="off"/></label><label>Invitation secret<input name="secret" type="password" value={secret} onChange={e=>setSecret(e.target.value)} required minLength={43} maxLength={43} autoComplete="off"/></label><button>Verify invitation</button></>:stage==="verifying"?<><button type="button" onClick={()=>void send("request_code")}>Request email verification code</button><label>Mailbox verification code<input name="code" value={code} onChange={e=>setCode(e.target.value)} required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{8}" minLength={8} maxLength={8}/></label><button>Verify mailbox</button><p>Codes expire after ten minutes. Requests are limited; wait at least one minute before requesting another code.</p></>:<><label>New password<input name="password" type="password" value={password} onChange={e=>setPassword(e.target.value)} required minLength={12} maxLength={128} autoComplete="new-password"/></label><label>Confirm password<input name="confirmation" type="password" value={confirmation} onChange={e=>setConfirmation(e.target.value)} required minLength={12} maxLength={128} autoComplete="new-password"/></label><button>Set password and create inactive identity</button></>}
      </fieldset>
    </form>:<p>Your identity is inactive. TOTP enrollment and activation are not yet available. No administration access has been granted.</p>}
    {stage==="mailbox_verified"&&<button type="button" disabled={busy} onClick={()=>void send("request_code")}>Request new mailbox verification</button>}
    <p role="status" aria-live="polite">{busy?"Working…":message}</p>
    {stage!=="entry"&&stage!=="provisioned"&&<p>If this invitation expired or was revoked, contact the inviting administrator. This browser can resume the current attempt after a reload.</p>}
    </section></main>;
}
