'use strict';

const fs = require('fs/promises');
const path = require('path');

const ALLOWED_UPLOADS = new Map([
  ['.jpg', { mimes: new Set(['image/jpeg']), matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff }],
  ['.jpeg', { mimes: new Set(['image/jpeg']), matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff }],
  ['.png', { mimes: new Set(['image/png']), matches: (b) => b.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])) }],
  ['.gif', { mimes: new Set(['image/gif']), matches: (b) => ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('ascii')) }],
  ['.webp', { mimes: new Set(['image/webp']), matches: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' }],
  ['.pdf', { mimes: new Set(['application/pdf']), matches: (b) => b.subarray(0, 5).toString('ascii') === '%PDF-' }]
]);

function uploadTypeFor(originalName, mimeType) {
  const extension = path.extname(String(originalName || '')).toLowerCase();
  const definition = ALLOWED_UPLOADS.get(extension);
  if (!definition || !definition.mimes.has(String(mimeType || '').toLowerCase())) return null;
  return { extension, definition };
}

async function validateUploadedFile(file) {
  const type = uploadTypeFor(file.originalname, file.mimetype);
  if (!type) return false;
  const handle = await fs.open(file.path, 'r');
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead >= 5 && type.definition.matches(header.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

module.exports = { ALLOWED_UPLOADS, uploadTypeFor, validateUploadedFile };
