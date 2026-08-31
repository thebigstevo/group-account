'use strict';

const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const src = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(src, 'public', 'app.js'), 'utf8');

function modalDom() {
  const dom = new JSDOM(`<!doctype html><html><body>
    <button type="button" data-add-member-open aria-controls="add-member-modal" aria-expanded="false">Add Member</button>
    <div id="add-member-modal" class="modal-backdrop" role="dialog" aria-hidden="true">
      <div class="modal modal--form">
        <button type="button" data-add-member-close>Close</button>
        <input id="modal-member-first" name="first_name">
        <button type="button" data-add-member-close>Cancel</button>
      </div>
    </div>
  </body></html>`, { url: 'https://example.test/members', runScripts: 'dangerously' });
  dom.window.eval(appSource);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  return dom;
}

describe('Add Member modal', () => {
  test('members page uses CSP-compatible controls without inline scripts', async () => {
    const html = await ejs.renderFile(path.join(src, 'views', 'members.ejs'), {
      user: { id: 1, name: 'Administrator', role: 'admin' },
      currentPath: '/members',
      csrfToken: 'csrf-token',
      groupName: 'KSJI',
      groupCurrency: 'GHS',
      assetVersion: 'test',
      activeFiscalYear: { year: 2024 },
      canEdit: true,
      members: [],
      formatDate: String,
      formatMoney: String
    });

    expect(html).toContain('data-add-member-open');
    expect(html).toContain('data-add-member-close');
    expect(html).not.toContain('onclick=');
    expect(html).not.toContain('<script>');
  });

  test('button opens the modal, moves focus, and updates accessibility state', () => {
    const dom = modalDom();
    const trigger = dom.window.document.querySelector('[data-add-member-open]');
    const modal = dom.window.document.getElementById('add-member-modal');

    trigger.click();

    expect(modal.classList.contains('active')).toBe(true);
    expect(modal.getAttribute('aria-hidden')).toBe('false');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(dom.window.document.body.classList.contains('modal-open')).toBe(true);
    expect(dom.window.document.activeElement.id).toBe('modal-member-first');
  });

  test.each([
    ['close control', (dom) => dom.window.document.querySelector('[data-add-member-close]').click()],
    ['Escape key', (dom) => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))],
    ['backdrop', (dom) => dom.window.document.getElementById('add-member-modal').click()]
  ])('%s closes the modal and restores focus', (_name, closeModal) => {
    const dom = modalDom();
    const trigger = dom.window.document.querySelector('[data-add-member-open]');
    const modal = dom.window.document.getElementById('add-member-modal');
    trigger.click();

    closeModal(dom);

    expect(modal.classList.contains('active')).toBe(false);
    expect(modal.getAttribute('aria-hidden')).toBe('true');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(dom.window.document.body.classList.contains('modal-open')).toBe(false);
    expect(dom.window.document.activeElement).toBe(trigger);
  });
});
