import BusinessPage from "../../business-page";
export const dynamic="force-dynamic";
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){const v=(await searchParams).cursor;return <BusinessPage mode="offers" cursor={typeof v==="string"?v:v===undefined?undefined:"invalid"}/>;}
