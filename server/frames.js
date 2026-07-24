import sharp from "sharp";

// Reject images that decode to more than this many pixels. A small JPEG can
// decompress to a huge raw buffer ("decompression bomb"); cap the decode so a
// crafted upload can't exhaust server memory. 40MP comfortably covers any real
// webcam frame.
const SHARP_OPTS = { limitInputPixels: 40_000_000 };

// 8x8 average hash — cheap perceptual hash used to skip near-identical
// consecutive frames so the judge isn't billed for 120 copies of the same shot.
export async function averageHash(jpegBuffer) {
  const pixels = await sharp(jpegBuffer, SHARP_OPTS)
    .grayscale()
    .resize(8, 8, { fit: "fill" })
    .raw()
    .toBuffer();
  let sum = 0;
  for (const p of pixels) sum += p;
  const mean = sum / pixels.length;
  const bits = new Uint8Array(8);
  for (let i = 0; i < 64; i++) {
    if (pixels[i] > mean) bits[i >> 3] |= 1 << (i & 7);
  }
  return bits;
}

export function hammingDistance(a, b) {
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let x = a[i] ^ b[i];
    while (x) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist;
}

// Normalize an uploaded frame: cap the long edge at 768px (keeps GPT-4.1-mini
// image-token cost predictable) and re-encode as JPEG.
export async function normalizeFrame(jpegBuffer) {
  return sharp(jpegBuffer, SHARP_OPTS)
    .rotate() // honor EXIF orientation
    .resize(768, 768, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 78 })
    .toBuffer();
}

// Evenly sample up to `max` frames across the whole battle so the judge sees
// early, middle, and late showcases rather than just the first N seconds.
export function sampleEvenly(frames, max) {
  if (frames.length <= max) return frames;
  const out = [];
  const step = frames.length / max;
  for (let i = 0; i < max; i++) {
    out.push(frames[Math.floor(i * step)]);
  }
  return out;
}
