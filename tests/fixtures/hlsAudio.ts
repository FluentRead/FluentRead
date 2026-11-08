// Minimal ISO BMFF metadata for audio-track selection tests; browser cases use actual encoded AAC/H.264.
export function mp4Box(type: string, payload: Uint8Array = new Uint8Array(), sizeMode: 'normal' | 'large' | 'rest' = 'normal'): Uint8Array<ArrayBuffer> {
  const header = sizeMode === 'large' ? 16 : 8;
  const bytes = new Uint8Array(header + payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, sizeMode === 'large' ? 1 : sizeMode === 'rest' ? 0 : bytes.length);
  bytes.set(new TextEncoder().encode(type), 4);
  if (sizeMode === 'large') view.setBigUint64(8, BigInt(bytes.length));
  bytes.set(payload, header);
  return bytes;
}
export function mp4Init(handler: 'soun' | 'vide'): Uint8Array<ArrayBuffer> {
  const payload = new Uint8Array(12);
  payload.set(new TextEncoder().encode(handler), 8);
  return mp4Box('moov', mp4Box('trak', mp4Box('mdia', mp4Box('hdlr', payload))));
}
export const audioInit = mp4Init('soun');
export const videoInit = mp4Init('vide');
export const joinBytes = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
};
