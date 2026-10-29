import CmsPage from "../cms-page";
export const dynamic="force-dynamic";
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){return <CmsPage kinds={["size-guide"]} title="Size guides" cursor={(await searchParams).cursor}/>;}
