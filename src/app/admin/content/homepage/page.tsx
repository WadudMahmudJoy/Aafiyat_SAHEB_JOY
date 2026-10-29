import CmsPage from "../cms-page";
export const dynamic="force-dynamic";
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){return <CmsPage kinds={["hero","banner","story"]} title="Homepage content" cursor={(await searchParams).cursor}/>;}
