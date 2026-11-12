import qrcode from "qrcode-generator";

export const QUIET_ZONE = 4; // modules; required margin for reliable scanning

/** Dark-module matrix for `text` (error correction M, auto version). */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** SVG path (one rect per dark module) in a viewBox that includes the quiet zone. */
export function qrPath(matrix: boolean[][]): { d: string; size: number } {
  let d = "";
  matrix.forEach((row, r) =>
    row.forEach((dark, c) => {
      if (dark) d += `M${c + QUIET_ZONE} ${r + QUIET_ZONE}h1v1h-1z`;
    }),
  );
  return { d, size: matrix.length + QUIET_ZONE * 2 };
}
