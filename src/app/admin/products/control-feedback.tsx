"use client";
import { createContext,useState,type ReactNode } from "react";
import styles from "../inventory/inventory.module.css";
export const ControlFeedbackContext=createContext<(message:string)=>void>(()=>{});
export default function ControlFeedback({children}:{children:ReactNode}){const [message,setMessage]=useState("");return <ControlFeedbackContext.Provider value={setMessage}>{message&&<div role="status" className={styles.message}><strong>Last confirmed operation:</strong> {message}</div>}{children}</ControlFeedbackContext.Provider>;}
