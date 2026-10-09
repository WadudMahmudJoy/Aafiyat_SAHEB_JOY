import VariantEditor from "../../../../variant-editor";
export const dynamic = "force-dynamic";
export default async function EditVariantPage({ params }: { params: Promise<{ id: string; variantId: string }> }) { const { id, variantId } = await params; return <VariantEditor productId={id} variantId={variantId} />; }
