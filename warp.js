// Pure-JS perspective transform.
// Given 4 source corners (in reading order: TL, TR, BR, BL) in a source canvas,
// produces a destination canvas with the receipt warped to an axis-aligned
// rectangle (upright, cropped).

function solveLinear8x8(A, b) {
  // Gaussian elimination with partial pivoting. Mutates A, b.
  const n = 8;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(A[row][col]) > Math.abs(A[pivot][col])) pivot = row;
    }
    if (pivot !== col) {
      [A[col], A[pivot]] = [A[pivot], A[col]];
      [b[col], b[pivot]] = [b[pivot], b[col]];
    }
    const denom = A[col][col];
    if (Math.abs(denom) < 1e-12) throw new Error('Singular matrix');
    for (let row = col + 1; row < n; row++) {
      const factor = A[row][col] / denom;
      if (factor === 0) continue;
      for (let k = col; k < n; k++) A[row][k] -= factor * A[col][k];
      b[row] -= factor * b[col];
    }
  }
  const x = new Array(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let s = b[row];
    for (let k = row + 1; k < n; k++) s -= A[row][k] * x[k];
    x[row] = s / A[row][row];
  }
  return x;
}

// Returns 3x3 homography (flat, length 9, h33=1) mapping src -> dst.
export function solveHomography(src, dst) {
  const A = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const b = new Array(8).fill(0);
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [X, Y] = dst[i];
    A[2 * i]     = [x, y, 1, 0, 0, 0, -X * x, -X * y];
    A[2 * i + 1] = [0, 0, 0, x, y, 1, -Y * x, -Y * y];
    b[2 * i]     = X;
    b[2 * i + 1] = Y;
  }
  const h = solveLinear8x8(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

// Pick an output size roughly preserving receipt aspect ratio at high resolution.
export function outputSizeFromCorners(srcCorners) {
  const [tl, tr, br, bl] = srcCorners;
  const topWidth    = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
  const botWidth    = Math.hypot(br[0] - bl[0], br[1] - bl[1]);
  const leftHeight  = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]);
  const rightHeight = Math.hypot(br[0] - tr[0], br[1] - tr[1]);
  const width  = Math.max(50, Math.round(Math.max(topWidth, botWidth)));
  const height = Math.max(50, Math.round(Math.max(leftHeight, rightHeight)));
  return [width, height];
}

// Warp srcCanvas using srcCorners (in pixels) -> axis-aligned [w,h] canvas.
// Inverse-map each destination pixel, bilinear sample source.
export function warpImage(srcCanvas, srcCorners, dstWidth, dstHeight) {
  const dstCorners = [
    [0, 0],
    [dstWidth - 1, 0],
    [dstWidth - 1, dstHeight - 1],
    [0, dstHeight - 1],
  ];
  // Inverse homography: dst -> src.
  const H = solveHomography(dstCorners, srcCorners);

  const srcCtx = srcCanvas.getContext('2d');
  const src = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
  const sw = src.width, sh = src.height;
  const sd = src.data;

  const dst = document.createElement('canvas');
  dst.width = dstWidth;
  dst.height = dstHeight;
  const dstCtx = dst.getContext('2d');
  const out = dstCtx.createImageData(dstWidth, dstHeight);
  const od = out.data;

  const h11 = H[0], h12 = H[1], h13 = H[2];
  const h21 = H[3], h22 = H[4], h23 = H[5];
  const h31 = H[6], h32 = H[7];

  for (let Y = 0; Y < dstHeight; Y++) {
    for (let X = 0; X < dstWidth; X++) {
      const w = h31 * X + h32 * Y + 1;
      const sx = (h11 * X + h12 * Y + h13) / w;
      const sy = (h21 * X + h22 * Y + h23) / w;
      const i = (Y * dstWidth + X) * 4;
      if (sx < 0 || sx >= sw - 1 || sy < 0 || sy >= sh - 1) {
        od[i] = 255; od[i + 1] = 255; od[i + 2] = 255; od[i + 3] = 255;
        continue;
      }
      const x0 = sx | 0, y0 = sy | 0;
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i01 = i00 + 4;
      const i10 = i00 + sw * 4;
      const i11 = i10 + 4;
      const w00 = (1 - fx) * (1 - fy);
      const w01 = fx * (1 - fy);
      const w10 = (1 - fx) * fy;
      const w11 = fx * fy;
      od[i]     = sd[i00]     * w00 + sd[i01]     * w01 + sd[i10]     * w10 + sd[i11]     * w11;
      od[i + 1] = sd[i00 + 1] * w00 + sd[i01 + 1] * w01 + sd[i10 + 1] * w10 + sd[i11 + 1] * w11;
      od[i + 2] = sd[i00 + 2] * w00 + sd[i01 + 2] * w01 + sd[i10 + 2] * w10 + sd[i11 + 2] * w11;
      od[i + 3] = 255;
    }
  }
  dstCtx.putImageData(out, 0, 0);
  return dst;
}

// corners: array of 4 [x,y] in fractions [0,1]. Validate strictly.
export function validCorners(corners) {
  if (!Array.isArray(corners) || corners.length !== 4) return false;
  for (const p of corners) {
    if (!Array.isArray(p) || p.length !== 2) return false;
    const [x, y] = p;
    if (typeof x !== 'number' || typeof y !== 'number') return false;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (x < 0 || x > 1 || y < 0 || y > 1) return false;
  }
  return true;
}
