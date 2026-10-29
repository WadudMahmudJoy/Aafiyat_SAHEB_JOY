import CmsPage from "../cms-page";
export const dynamic="force-dynamic";
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){return <CmsPage kinds={["page"]} title="Informational pages" cursor={(await searchParams).cursor}/>;}
