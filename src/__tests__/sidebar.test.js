'use strict';

const ejs = require('ejs');
const path = require('path');

describe('sidebar authentication controls', () => {
  test('sign out submits a CSRF-protected POST instead of navigating with GET', async () => {
    const filename = path.join(__dirname, '..', 'views', 'partials', 'sidebar.ejs');
    const html = await ejs.renderFile(filename, {
      user: { id: 1, name: 'System Admin', role: 'admin' },
      currentPath: '/',
      csrfToken: 'test-csrf-token',
    });

    expect(html).toContain('method="post" action="/logout"');
    expect(html).toContain('name="_csrf" value="test-csrf-token"');
    expect(html).toContain('type="submit"');
    expect(html).not.toContain('href="/logout"');
  });
});
