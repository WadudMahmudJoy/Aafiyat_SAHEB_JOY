"use client";
import { useEffect, useRef, useState } from "react";

export default function ProductCover({ image }: { image?: { url: string; altText: string } }) {
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const img=ref.current;
    if (img?.complete && img.naturalWidth===0) setFailed(true);
  }, []);
  if (!image || failed) return <p role="status">Product image unavailable.</p>;
  // The private endpoint checks the current session; it never exposes storage keys.
  // eslint-disable-next-line @next/next/no-img-element
  return <><img ref={ref} src={image.url} alt={image.altText} width={120} height={120} onError={() => setFailed(true)} /><noscript><p>Product image: {image.altText}. If the image is unavailable, contact a catalogue administrator.</p></noscript></>;
}
