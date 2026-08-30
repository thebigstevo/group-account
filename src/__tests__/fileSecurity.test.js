const fs = require('fs');
const os = require('os');
const path = require('path');
const { uploadTypeFor, validateUploadedFile } = require('../fileSecurity');

describe('uploaded accounting evidence validation', () => {
  let directory;

  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'treasurio-upload-')); });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

  test.each([
    ['receipt.jpg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01])],
    ['receipt.png', 'image/png', Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])],
    ['receipt.gif', 'image/gif', Buffer.from('GIF89a')],
    ['receipt.webp', 'image/webp', Buffer.from('RIFF0000WEBP')],
    ['voucher.pdf', 'application/pdf', Buffer.from('%PDF-1.7')]
  ])('accepts valid %s contents', async (originalname, mimetype, contents) => {
    const filePath = path.join(directory, 'upload');
    fs.writeFileSync(filePath, contents);
    await expect(validateUploadedFile({ originalname, mimetype, path: filePath })).resolves.toBe(true);
  });

  test('rejects spoofed extensions, MIME types, and file signatures', async () => {
    const filePath = path.join(directory, 'upload');
    fs.writeFileSync(filePath, Buffer.from('<script>alert(1)</script>'));
    expect(uploadTypeFor('evidence.svg', 'image/svg+xml')).toBeNull();
    expect(uploadTypeFor('evidence.pdf', 'text/html')).toBeNull();
    await expect(validateUploadedFile({ originalname: 'evidence.pdf', mimetype: 'application/pdf', path: filePath })).resolves.toBe(false);
  });
});
