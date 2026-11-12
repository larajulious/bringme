import { qrMatrix, qrPath } from "@/lib/site/qr";

/**
 * Server-rendered SVG QR code (no client JS). Dark purple on white with the
 * 4-module quiet zone scanners need; scales to any size.
 */
export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const { d, size } = qrPath(qrMatrix(value));
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className={className}
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#2a0f5c" />
    </svg>
  );
}
