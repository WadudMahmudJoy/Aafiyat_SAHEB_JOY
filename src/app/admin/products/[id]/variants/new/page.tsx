import VariantEditor from "../../../variant-editor";
export const dynamic = "force-dynamic";
export default async function NewVariantPage({ params }: { params: Promise<{ id: string }> }) { return <VariantEditor productId={(await params).id} />; }
