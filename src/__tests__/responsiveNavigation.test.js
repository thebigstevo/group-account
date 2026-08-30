'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function navigationDom({ desktop = false } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body class="app-page">
    <button data-sidebar-toggle aria-expanded="false">Menu</button>
    <aside class="sidebar" aria-hidden="false">
      <button data-sidebar-close>Close</button>
      <a class="sidebar__link" href="/finance">Finance</a>
      <a class="sidebar__link" href="/members">Members</a>
    </aside>
    <button data-sidebar-backdrop></button>
  </body></html>`, { url: 'https://example.test/', runScripts: 'dangerously' });
  dom.window.matchMedia = jest.fn().mockImplementation((query) => ({
    matches: query.includes('min-width') ? desktop : !desktop,
    media: query,
    addListener: jest.fn(),
    removeListener: jest.fn()
  }));
  dom.window.document.querySelectorAll('a').forEach((link) => link.addEventListener('click', (event) => event.preventDefault()));
  dom.window.eval(appSource);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  return dom;
}

describe('responsive navigation drawer', () => {
  test('hamburger opens the drawer, locks scroll, updates aria, and moves focus', () => {
    const dom = navigationDom();
    const button = dom.window.document.querySelector('[data-sidebar-toggle]');
    button.click();
    expect(dom.window.document.querySelector('.sidebar').classList.contains('sidebar--open')).toBe(true);
    expect(dom.window.document.body.classList.contains('drawer-open')).toBe(true);
    expect(dom.window.document.querySelector('[data-sidebar-backdrop]').classList.contains('active')).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(dom.window.document.activeElement).toBe(dom.window.document.querySelector('[data-sidebar-close]'));
  });

  test.each([
    ['close button', '[data-sidebar-close]', null],
    ['backdrop', '[data-sidebar-backdrop]', null],
    ['navigation selection', 'a[href="/finance"]', null],
    ['Escape', null, 'Escape']
  ])('%s closes the drawer and returns focus to the hamburger', (_name, selector, key) => {
    const dom = navigationDom();
    const button = dom.window.document.querySelector('[data-sidebar-toggle]');
    button.click();
    if (key) dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
    else dom.window.document.querySelector(selector).click();
    expect(dom.window.document.querySelector('.sidebar').classList.contains('sidebar--open')).toBe(false);
    expect(dom.window.document.body.classList.contains('drawer-open')).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(dom.window.document.activeElement).toBe(button);
  });

  test('desktop viewport keeps the persistent sidebar exposed', () => {
    const dom = navigationDom({ desktop: true });
    expect(dom.window.document.querySelector('.sidebar').getAttribute('aria-hidden')).toBe('false');
  });
});
