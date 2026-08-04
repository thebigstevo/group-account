/**
 * Treasurio Client-Side Application
 * ===================================
 * Vanilla JS components for the Treasurio financial management application.
 * Components: DataTable, Toast, Modal, Sidebar, FormValidation
 *
 * All components are exposed on the global `window.Treasurio` namespace.
 */
(function (window, document) {
  'use strict';

  /** @namespace Treasurio */
  const Treasurio = {};

  // ─────────────────────────────────────────────────────────────────────────────
  // UTILITIES
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Debounce a function call.
   * @param {Function} fn - Function to debounce
   * @param {number} delay - Delay in milliseconds
   * @returns {Function}
   */
  function debounce(fn, delay) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  /**
   * Generate a unique ID string.
   * @returns {string}
   */
  function uid() {
    return 'tr-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. DATA TABLE COMPONENT
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * @typedef {Object} DataTableInstance
   * @property {Function} sort - Sort by column
   * @property {Function} filter - Filter rows by search term
   * @property {Function} paginate - Navigate to page with given page size
   */

  /**
   * DataTable — sortable, filterable, paginated table component.
   * Attaches to a table element and provides client-side sort, filter, and pagination.
   *
   * @namespace Treasurio.DataTable
   */
  Treasurio.DataTable = (function () {
    /** @type {Map<HTMLElement, DataTableInstance>} */
    const instances = new Map();

    /**
     * Initialize a DataTable on the given table element.
     * @param {HTMLElement} tableEl - The <table> element to enhance
     * @returns {DataTableInstance}
     */
    function init(tableEl) {
      if (!tableEl) return null;
      if (instances.has(tableEl)) return instances.get(tableEl);

      const state = {
        allRows: [],
        filteredRows: [],
        sortColumn: null,
        sortDirection: 'asc',
        filterTerm: '',
        currentPage: 1,
        pageSize: 10
      };

      // Capture original rows
      const tbody = tableEl.querySelector('tbody');
      if (!tbody) return null;
      state.allRows = Array.from(tbody.querySelectorAll('tr'));
      state.filteredRows = state.allRows.slice();

      // Create wrapper for pagination controls
      const wrapper = tableEl.closest('.data-table-wrapper') || tableEl.parentElement;

      // Find or create search input
      const searchInput = wrapper
        ? wrapper.querySelector('[data-table-search]')
        : null;

      // Attach sort handlers to column headers
      const headers = tableEl.querySelectorAll('thead th[data-sortable]');
      headers.forEach(function (th, index) {
        th.style.cursor = 'pointer';
        th.setAttribute('aria-sort', 'none');
        th.addEventListener('click', function () {
          const col = th.dataset.sortable || th.dataset.column || String(index);
          const newDir = (state.sortColumn === col && state.sortDirection === 'asc')
            ? 'desc'
            : 'asc';
          sort(col, newDir);
        });
      });

      // Attach search/filter handler
      if (searchInput) {
        const debouncedFilter = debounce(function (e) {
          filter(e.target.value);
        }, 300);
        searchInput.addEventListener('input', debouncedFilter);
      }

      /**
       * Sort rows by column.
       * @param {string} column - Column identifier (data-sortable value or index)
       * @param {'asc'|'desc'} direction - Sort direction
       */
      function sort(column, direction) {
        state.sortColumn = column;
        state.sortDirection = direction;

        // Find column index
        const ths = Array.from(tableEl.querySelectorAll('thead th'));
        let colIndex = -1;
        ths.forEach(function (th, i) {
          const col = th.dataset.sortable || th.dataset.column || String(i);
          if (col === column) colIndex = i;
          // Clear all arrow indicators
          th.setAttribute('aria-sort', 'none');
          const arrow = th.querySelector('.sort-arrow');
          if (arrow) arrow.remove();
        });

        if (colIndex === -1) return;

        // Set active arrow indicator
        const activeTh = ths[colIndex];
        activeTh.setAttribute('aria-sort', direction === 'asc' ? 'ascending' : 'descending');
        const arrowSpan = document.createElement('span');
        arrowSpan.className = 'sort-arrow';
        arrowSpan.setAttribute('aria-hidden', 'true');
        arrowSpan.textContent = direction === 'asc' ? ' ▲' : ' ▼';
        activeTh.appendChild(arrowSpan);

        // Sort the filtered rows (preserves active filter — Property 6)
        state.filteredRows.sort(function (rowA, rowB) {
          const cellA = rowA.children[colIndex]
            ? rowA.children[colIndex].textContent.trim()
            : '';
          const cellB = rowB.children[colIndex]
            ? rowB.children[colIndex].textContent.trim()
            : '';

          // Attempt numeric comparison
          const numA = parseFloat(cellA.replace(/[^0-9.\-]/g, ''));
          const numB = parseFloat(cellB.replace(/[^0-9.\-]/g, ''));

          let cmp;
          if (!isNaN(numA) && !isNaN(numB)) {
            cmp = numA - numB;
          } else {
            cmp = cellA.localeCompare(cellB, undefined, { sensitivity: 'base' });
          }

          return direction === 'asc' ? cmp : -cmp;
        });

        render();
      }

      /**
       * Filter rows by case-insensitive substring match across all columns.
       * Resets pagination to page 1.
       * @param {string} term - Search term
       */
      function filter(term) {
        state.filterTerm = (term || '').trim().toLowerCase();
        state.currentPage = 1;

        if (!state.filterTerm) {
          state.filteredRows = state.allRows.slice();
        } else {
          state.filteredRows = state.allRows.filter(function (row) {
            return row.textContent.toLowerCase().includes(state.filterTerm);
          });
        }

        // Re-apply sort if active
        if (state.sortColumn) {
          sort(state.sortColumn, state.sortDirection);
          return; // sort calls render
        }

        render();
      }

      /**
       * Paginate to a specific page with the given page size.
       * @param {number} page - 1-indexed page number
       * @param {number} [pageSize] - Items per page (10, 25, or 50)
       */
      function paginate(page, pageSize) {
        if (pageSize !== undefined) {
          state.pageSize = pageSize;
        }
        const totalPages = Math.max(1, Math.ceil(state.filteredRows.length / state.pageSize));
        state.currentPage = Math.max(1, Math.min(page, totalPages));
        render();
      }

      /**
       * Render the current page of rows and pagination controls.
       */
      function render() {
        const totalRows = state.filteredRows.length;
        const totalPages = Math.max(1, Math.ceil(totalRows / state.pageSize));
        const startIdx = (state.currentPage - 1) * state.pageSize;
        const endIdx = Math.min(startIdx + state.pageSize, totalRows);
        const pageRows = state.filteredRows.slice(startIdx, endIdx);

        // Hide all rows, show only current page
        state.allRows.forEach(function (row) {
          row.style.display = 'none';
        });
        pageRows.forEach(function (row) {
          row.style.display = '';
        });

        // Empty state message
        let emptyMsg = wrapper ? wrapper.querySelector('.data-table-empty') : null;
        if (totalRows === 0) {
          if (!emptyMsg) {
            emptyMsg = document.createElement('p');
            emptyMsg.className = 'data-table-empty';
            emptyMsg.setAttribute('role', 'status');
            emptyMsg.textContent = 'No matching results found.';
            if (wrapper) wrapper.appendChild(emptyMsg);
            else tableEl.parentElement.appendChild(emptyMsg);
          }
          emptyMsg.style.display = '';
          tableEl.style.display = 'none';
        } else {
          if (emptyMsg) emptyMsg.style.display = 'none';
          tableEl.style.display = '';
        }

        // Render pagination controls
        renderPagination(totalPages);
      }

      /**
       * Render pagination controls: prev, page buttons (max 5), next, page size selector.
       * @param {number} totalPages
       */
      function renderPagination(totalPages) {
        let paginationEl = wrapper ? wrapper.querySelector('.data-table-pagination') : null;
        if (!paginationEl) {
          paginationEl = document.createElement('div');
          paginationEl.className = 'data-table-pagination';
          if (wrapper) wrapper.appendChild(paginationEl);
          else tableEl.parentElement.appendChild(paginationEl);
        }

        paginationEl.innerHTML = '';

        if (totalPages <= 1 && state.filteredRows.length <= 10) {
          return; // No pagination needed for small datasets
        }

        // Previous button
        const prevBtn = document.createElement('button');
        prevBtn.className = 'btn btn--secondary btn--sm';
        prevBtn.textContent = '← Prev';
        prevBtn.disabled = state.currentPage <= 1;
        prevBtn.addEventListener('click', function () {
          paginate(state.currentPage - 1);
        });
        paginationEl.appendChild(prevBtn);

        // Page number buttons (max 5 visible)
        const startPage = Math.max(1, state.currentPage - 2);
        const endPage = Math.min(totalPages, startPage + 4);
        for (let p = startPage; p <= endPage; p++) {
          const pageBtn = document.createElement('button');
          pageBtn.className = 'btn btn--sm' + (p === state.currentPage ? ' btn--primary' : ' btn--secondary');
          pageBtn.textContent = String(p);
          pageBtn.setAttribute('aria-current', p === state.currentPage ? 'page' : 'false');
          pageBtn.addEventListener('click', function () {
            paginate(p);
          });
          paginationEl.appendChild(pageBtn);
        }

        // Next button
        const nextBtn = document.createElement('button');
        nextBtn.className = 'btn btn--secondary btn--sm';
        nextBtn.textContent = 'Next →';
        nextBtn.disabled = state.currentPage >= totalPages;
        nextBtn.addEventListener('click', function () {
          paginate(state.currentPage + 1);
        });
        paginationEl.appendChild(nextBtn);

        // Page size selector
        const sizeSelect = document.createElement('select');
        sizeSelect.className = 'data-table-page-size';
        sizeSelect.setAttribute('aria-label', 'Rows per page');
        [10, 25, 50].forEach(function (size) {
          const opt = document.createElement('option');
          opt.value = size;
          opt.textContent = size + ' per page';
          opt.selected = size === state.pageSize;
          sizeSelect.appendChild(opt);
        });
        sizeSelect.addEventListener('change', function () {
          paginate(1, parseInt(sizeSelect.value, 10));
        });
        paginationEl.appendChild(sizeSelect);
      }

      // Initial render
      render();

      const instance = { sort: sort, filter: filter, paginate: paginate };
      instances.set(tableEl, instance);
      return instance;
    }

    return { init: init };
  })();

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. TOAST COMPONENT
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Toast — notification overlay component.
   * Shows brief messages in the top-right corner with auto-dismiss.
   *
   * @namespace Treasurio.Toast
   */
  Treasurio.Toast = (function () {
    const MAX_VISIBLE = 3;
    const DEFAULT_DURATION = 4000;
    /** @type {Array<{id: string, el: HTMLElement, timer: number|null}>} */
    let activeToasts = [];
    let container = null;

    /**
     * Get or create the toast container element.
     * @returns {HTMLElement}
     */
    function getContainer() {
      if (container && document.body.contains(container)) return container;
      container = document.querySelector('.toast-container');
      if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        container.setAttribute('aria-live', 'polite');
        container.setAttribute('aria-atomic', 'false');
        document.body.appendChild(container);
      }
      return container;
    }

    /**
     * Show a toast notification.
     * @param {string} message - The message to display
     * @param {'success'|'danger'} type - Toast type/theme
     * @param {number} [duration] - Auto-dismiss duration in ms (default 4000 for success, Infinity for danger)
     * @returns {string} Toast ID for manual dismissal
     */
    function show(message, type, duration) {
      type = type || 'success';
      if (duration === undefined) {
        duration = type === 'danger' ? Infinity : DEFAULT_DURATION;
      }

      const id = uid();
      const toastEl = document.createElement('div');
      toastEl.className = 'toast toast--' + type;
      toastEl.id = id;
      toastEl.setAttribute('role', type === 'danger' ? 'alert' : 'status');

      const msgSpan = document.createElement('span');
      msgSpan.className = 'toast__message';
      msgSpan.textContent = message;
      toastEl.appendChild(msgSpan);

      // Close button
      const closeBtn = document.createElement('button');
      closeBtn.className = 'toast__close';
      closeBtn.setAttribute('aria-label', 'Dismiss notification');
      closeBtn.innerHTML = '&times;';
      closeBtn.addEventListener('click', function () { dismiss(id); });
      closeBtn.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          dismiss(id);
        }
      });
      toastEl.appendChild(closeBtn);

      const cont = getContainer();
      cont.prepend(toastEl);

      // Auto-dismiss timer
      let timer = null;
      if (duration !== Infinity && duration > 0) {
        timer = setTimeout(function () { dismiss(id); }, duration);
      }

      activeToasts.unshift({ id: id, el: toastEl, timer: timer });

      // Enforce max visible: auto-dismiss oldest when exceeding limit
      while (activeToasts.length > MAX_VISIBLE) {
        const oldest = activeToasts[activeToasts.length - 1];
        dismiss(oldest.id);
      }

      return id;
    }

    /**
     * Dismiss a toast by ID.
     * @param {string} id - Toast ID to dismiss
     */
    function dismiss(id) {
      const idx = activeToasts.findIndex(function (t) { return t.id === id; });
      if (idx === -1) return;

      const toast = activeToasts[idx];
      if (toast.timer) clearTimeout(toast.timer);
      if (toast.el && toast.el.parentElement) {
        toast.el.remove();
      }
      activeToasts.splice(idx, 1);
    }

    return { show: show, dismiss: dismiss };
  })();

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. MODAL COMPONENT
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Modal — confirmation dialog component.
   * Traps focus, supports Escape/backdrop/Cancel close without executing action.
   *
   * @namespace Treasurio.Modal
   */
  Treasurio.Modal = (function () {
    let currentModal = null;
    let triggerElement = null;

    /**
     * Open a modal dialog.
     * @param {Object} options
     * @param {string} options.title - Dialog heading
     * @param {string} options.body - Dialog body/description
     * @param {Function} options.onConfirm - Callback executed on confirm
     * @param {string} [options.confirmText='Confirm'] - Confirm button label
     * @param {string} [options.cancelText='Cancel'] - Cancel button label
     * @param {string} [options.confirmClass='btn--danger'] - CSS class for confirm button
     */
    function open(options) {
      if (currentModal) close();

      triggerElement = document.activeElement;

      const titleId = uid();
      const bodyId = uid();

      // Create backdrop
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.addEventListener('click', close);

      // Create modal element
      const modal = document.createElement('div');
      modal.className = 'modal';
      modal.setAttribute('role', 'alertdialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-labelledby', titleId);
      modal.setAttribute('aria-describedby', bodyId);
      modal.tabIndex = -1;

      // Title
      const titleEl = document.createElement('h2');
      titleEl.className = 'modal__title';
      titleEl.id = titleId;
      titleEl.textContent = options.title || 'Confirm Action';
      modal.appendChild(titleEl);

      // Body
      const bodyEl = document.createElement('div');
      bodyEl.className = 'modal__body';
      bodyEl.id = bodyId;
      bodyEl.textContent = options.body || '';
      modal.appendChild(bodyEl);

      // Actions
      const actions = document.createElement('div');
      actions.className = 'modal__actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn--secondary';
      cancelBtn.textContent = options.cancelText || 'Cancel';
      cancelBtn.addEventListener('click', close);
      actions.appendChild(cancelBtn);

      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'btn ' + (options.confirmClass || 'btn--danger');
      confirmBtn.textContent = options.confirmText || 'Confirm';
      confirmBtn.addEventListener('click', function () {
        if (typeof options.onConfirm === 'function') {
          options.onConfirm();
        }
        close();
      });
      actions.appendChild(confirmBtn);

      modal.appendChild(actions);

      // Attach to DOM
      document.body.appendChild(backdrop);
      document.body.appendChild(modal);
      document.body.classList.add('modal-open');

      currentModal = { modal: modal, backdrop: backdrop };

      // Focus the modal
      modal.focus();

      // Focus trap and Escape handler
      modal.addEventListener('keydown', handleModalKeydown);
    }

    /**
     * Handle keydown events within the modal for focus trapping and Escape.
     * @param {KeyboardEvent} e
     */
    function handleModalKeydown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }

      if (e.key === 'Tab') {
        const modal = currentModal ? currentModal.modal : null;
        if (!modal) return;

        const focusable = modal.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    /**
     * Close the current modal without executing the confirm action.
     * Returns focus to the triggering element.
     */
    function close() {
      if (!currentModal) return;

      const { modal, backdrop } = currentModal;
      modal.removeEventListener('keydown', handleModalKeydown);
      modal.remove();
      backdrop.remove();
      document.body.classList.remove('modal-open');

      currentModal = null;

      // Return focus to triggering element
      if (triggerElement && typeof triggerElement.focus === 'function') {
        triggerElement.focus();
      }
      triggerElement = null;
    }

    return { open: open, close: close };
  })();

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. SIDEBAR COMPONENT
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Sidebar — mobile drawer toggle and active link highlighting.
   *
   * @namespace Treasurio.Sidebar
   */
  Treasurio.Sidebar = (function () {
    let sidebarEl = null;
    let backdropEl = null;
    let isOpen = false;
    let triggerEl = null;

    /**
     * Initialize sidebar references.
     */
    function initSidebar() {
      sidebarEl = document.querySelector('.sidebar');
      if (!sidebarEl) return;
      backdropEl = document.querySelector('[data-sidebar-backdrop]');
      if (backdropEl) backdropEl.addEventListener('click', closeSidebar);
      sidebarEl.querySelectorAll('[data-sidebar-close]').forEach(function (button) {
        button.addEventListener('click', closeSidebar);
      });
      sidebarEl.querySelectorAll('a').forEach(function (link) {
        link.addEventListener('click', closeSidebar);
      });
      setActive(window.location.pathname);
    }

    /**
     * Toggle the mobile sidebar drawer open/closed.
     */
    function toggle(event) {
      if (!sidebarEl) initSidebar();
      if (!sidebarEl) return;
      if (isOpen) {
        closeSidebar();
      } else {
        openSidebar(event && event.currentTarget);
      }
    }

    /**
     * Open the sidebar drawer with backdrop.
     */
    function openSidebar(opener) {
      if (!sidebarEl) return;
      triggerEl = opener || document.querySelector('[data-sidebar-toggle]');
      sidebarEl.classList.add('sidebar--open');
      sidebarEl.setAttribute('aria-hidden', 'false');
      if (backdropEl) backdropEl.classList.add('active');
      document.body.classList.add('drawer-open');
      document.querySelectorAll('[data-sidebar-toggle]').forEach(function (button) {
        button.setAttribute('aria-expanded', 'true');
        button.setAttribute('aria-label', 'Close navigation');
      });
      isOpen = true;
      document.addEventListener('keydown', handleSidebarEscape);
      const focusTarget = sidebarEl.querySelector('[data-sidebar-close], a, button');
      if (focusTarget) focusTarget.focus();
    }

    /**
     * Close the sidebar drawer and remove backdrop.
     */
    function closeSidebar(options) {
      if (!sidebarEl) return;
      sidebarEl.classList.remove('sidebar--open');
      if (window.matchMedia && window.matchMedia('(max-width: 1023px)').matches) {
        sidebarEl.setAttribute('aria-hidden', 'true');
      }
      if (backdropEl) backdropEl.classList.remove('active');
      document.body.classList.remove('drawer-open');
      document.querySelectorAll('[data-sidebar-toggle]').forEach(function (button) {
        button.setAttribute('aria-expanded', 'false');
        button.setAttribute('aria-label', 'Open navigation');
      });
      isOpen = false;
      document.removeEventListener('keydown', handleSidebarEscape);
      if ((!options || options.returnFocus !== false) && triggerEl && typeof triggerEl.focus === 'function') {
        triggerEl.focus();
      }
    }

    /**
     * Handle Escape key to close sidebar.
     * @param {KeyboardEvent} e
     */
    function handleSidebarEscape(e) {
      if (e.key === 'Escape') {
        closeSidebar();
        return;
      }
      if (e.key === 'Tab' && isOpen) {
        const focusable = Array.from(sidebarEl.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'));
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus();
        }
      }
    }

    /**
     * Set the active navigation link and highlight its parent group.
     * @param {string} path - The current URL path (e.g., '/transactions')
     */
    function setActive(path) {
      if (!sidebarEl) {
        sidebarEl = document.querySelector('.sidebar');
      }
      if (!sidebarEl) return;

      // Remove all active states
      sidebarEl.querySelectorAll('.sidebar__link').forEach(function (link) {
        link.classList.remove('sidebar__link--active');
      });
      sidebarEl.querySelectorAll('.sidebar__group').forEach(function (group) {
        group.classList.remove('sidebar__group--active');
      });

      // Find matching link
      const links = sidebarEl.querySelectorAll('.sidebar__link');
      let matched = null;
      links.forEach(function (link) {
        const href = link.getAttribute('href');
        if (href === path || (path !== '/' && href && path.startsWith(href))) {
          if (!matched || href.length > matched.getAttribute('href').length) {
            matched = link;
          }
        }
      });

      if (matched) {
        matched.classList.add('sidebar__link--active');
        // Highlight parent group
        const parentGroup = matched.closest('.sidebar__group');
        if (parentGroup) {
          parentGroup.classList.add('sidebar__group--active');
        }
      }
    }

    function resetForViewport() {
      if (!sidebarEl) initSidebar();
      if (!sidebarEl) return;
      if (window.matchMedia && window.matchMedia('(min-width: 1024px)').matches) {
        closeSidebar({ returnFocus: false });
        sidebarEl.setAttribute('aria-hidden', 'false');
      } else if (!isOpen) {
        sidebarEl.setAttribute('aria-hidden', 'true');
      }
    }

    return { init: initSidebar, toggle: toggle, open: openSidebar, setActive: setActive, close: closeSidebar, resetForViewport: resetForViewport };
  })();

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. FORM VALIDATION COMPONENT
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * FormValidation — inline field validation and submit button state management.
   *
   * @namespace Treasurio.FormValidation
   */
  Treasurio.FormValidation = (function () {
    /**
     * Initialize form validation on a form element.
     * @param {HTMLFormElement} formEl - The form to validate
     */
    function init(formEl) {
      if (!formEl) return;

      const submitBtn = formEl.querySelector('[type="submit"]');
      const fields = formEl.querySelectorAll('input, select, textarea');

      // Get fiscal year range from data attributes on the form
      const fiscalStart = formEl.dataset.fiscalStart || null;
      const fiscalEnd = formEl.dataset.fiscalEnd || null;

      // Initial submit button state
      updateSubmitState(formEl, submitBtn);

      fields.forEach(function (field) {
        // Validate on blur
        field.addEventListener('blur', function () {
          validateField(field, fiscalStart, fiscalEnd);
          updateSubmitState(formEl, submitBtn);
        });

        // Re-check submit state on input
        field.addEventListener('input', function () {
          // Clear error on input if it was previously shown
          const errorEl = getErrorElement(field);
          if (errorEl && field.value.trim()) {
            clearFieldError(field);
          }
          updateSubmitState(formEl, submitBtn);
        });
      });
    }

    /**
     * Validate a single field and show/clear error message.
     * @param {HTMLElement} field
     * @param {string|null} fiscalStart - Fiscal year start date (YYYY-MM-DD)
     * @param {string|null} fiscalEnd - Fiscal year end date (YYYY-MM-DD)
     * @returns {boolean} True if field is valid
     */
    function validateField(field, fiscalStart, fiscalEnd) {
      const value = field.value.trim();
      const isRequired = field.hasAttribute('required');
      const type = field.type || field.dataset.type || '';
      let errorMsg = '';

      // Required check
      if (isRequired && !value) {
        errorMsg = 'This field is required.';
      }

      // Numeric validation
      if (!errorMsg && value && (type === 'number' || field.dataset.validate === 'numeric')) {
        const num = parseFloat(value);
        if (isNaN(num) || num < 0 || num > 999999999.99) {
          errorMsg = 'Enter a valid amount between 0 and 999,999,999.99.';
        }
      }

      // Date validation
      if (!errorMsg && value && type === 'date') {
        const date = new Date(value);
        if (isNaN(date.getTime())) {
          errorMsg = 'Enter a valid date.';
        } else if (fiscalStart && fiscalEnd) {
          // Constrain to active fiscal year range
          const d = value; // YYYY-MM-DD string
          if (d < fiscalStart || d > fiscalEnd) {
            errorMsg = 'Date must be within the active fiscal year (' + fiscalStart + ' to ' + fiscalEnd + ').';
          }
        }
      }

      if (errorMsg) {
        showFieldError(field, errorMsg);
        return false;
      } else {
        clearFieldError(field);
        return true;
      }
    }

    /**
     * Show an inline error message below a field.
     * @param {HTMLElement} field
     * @param {string} message
     */
    function showFieldError(field, message) {
      field.classList.add('field--error');
      field.setAttribute('aria-invalid', 'true');

      let errorEl = getErrorElement(field);
      if (!errorEl) {
        errorEl = document.createElement('span');
        errorEl.className = 'field-error';
        errorEl.setAttribute('role', 'alert');
        const errorId = field.id ? field.id + '-error' : uid();
        errorEl.id = errorId;
        field.setAttribute('aria-describedby', errorId);
        field.parentElement.appendChild(errorEl);
      }
      errorEl.textContent = message;
    }

    /**
     * Clear the inline error message for a field.
     * @param {HTMLElement} field
     */
    function clearFieldError(field) {
      field.classList.remove('field--error');
      field.removeAttribute('aria-invalid');

      const errorEl = getErrorElement(field);
      if (errorEl) {
        errorEl.remove();
        field.removeAttribute('aria-describedby');
      }
    }

    /**
     * Get the error element associated with a field.
     * @param {HTMLElement} field
     * @returns {HTMLElement|null}
     */
    function getErrorElement(field) {
      const errorId = field.getAttribute('aria-describedby');
      if (errorId) {
        const el = document.getElementById(errorId);
        if (el && el.classList.contains('field-error')) return el;
      }
      // Fallback: find sibling error element
      if (field.parentElement) {
        return field.parentElement.querySelector('.field-error');
      }
      return null;
    }

    /**
     * Update submit button disabled state.
     * Disabled when any required field is empty or has a validation error.
     * @param {HTMLFormElement} formEl
     * @param {HTMLElement} submitBtn
     */
    function updateSubmitState(formEl, submitBtn) {
      if (!submitBtn) return;

      const fields = formEl.querySelectorAll('[required]');
      let hasError = false;

      fields.forEach(function (field) {
        if (!field.value.trim()) {
          hasError = true;
        }
        if (field.classList.contains('field--error')) {
          hasError = true;
        }
      });

      // Also check for any field (not just required) with active error
      formEl.querySelectorAll('.field--error').forEach(function () {
        hasError = true;
      });

      submitBtn.disabled = hasError;
    }

    return { init: init, validateField: validateField };
  })();

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. ADD MEMBER MODAL COMPONENT
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * AddMemberModal — form-based modal for adding members.
   * Provides focus trapping, Escape/backdrop close, background scroll prevention,
   * and auto-open when server returns validation errors.
   *
   * @namespace Treasurio.AddMemberModal
   */
  Treasurio.AddMemberModal = (function () {
    let modalEl = null;
    let triggerElement = null;
    let boundKeydownHandler = null;

    /** Selector for all focusable elements within the modal */
    const FOCUSABLE_SELECTOR =
      'button:not([disabled]), [href], input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    /**
     * Open the Add Member modal dialog.
     * Sets active class, prevents background scroll, installs focus trap and keyboard handlers.
     */
    function open() {
      modalEl = document.getElementById('add-member-modal');
      if (!modalEl) return;

      triggerElement = document.activeElement;

      // Show the modal
      modalEl.classList.add('active');
      document.body.classList.add('modal-open');

      // Focus the first visible input field
      var firstInput = modalEl.querySelector('input:not([type="hidden"])');
      if (firstInput) firstInput.focus();

      // Install keydown handler for Escape and focus trap
      boundKeydownHandler = handleKeydown;
      document.addEventListener('keydown', boundKeydownHandler);

      // Install click-outside handler on the backdrop
      modalEl.addEventListener('click', handleBackdropClick);
    }

    /**
     * Close the Add Member modal dialog.
     * Removes active class, restores background scroll, removes event handlers,
     * and returns focus to the triggering element.
     */
    function close() {
      modalEl = document.getElementById('add-member-modal');
      if (!modalEl) return;

      modalEl.classList.remove('active');
      document.body.classList.remove('modal-open');

      // Remove event handlers
      if (boundKeydownHandler) {
        document.removeEventListener('keydown', boundKeydownHandler);
        boundKeydownHandler = null;
      }
      modalEl.removeEventListener('click', handleBackdropClick);

      // Return focus to the triggering element
      if (triggerElement && typeof triggerElement.focus === 'function') {
        triggerElement.focus();
      }
      triggerElement = null;
    }

    /**
     * Handle keydown events: Escape to close, Tab/Shift+Tab for focus trap.
     * @param {KeyboardEvent} e
     */
    function handleKeydown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }

      if (e.key === 'Tab') {
        trapFocus(e);
      }
    }

    /**
     * Trap focus within the modal content when Tab/Shift+Tab is pressed.
     * Cycles through focusable elements without allowing focus to escape.
     * @param {KeyboardEvent} e
     */
    function trapFocus(e) {
      if (!modalEl) return;

      var modalContent = modalEl.querySelector('.modal--form') || modalEl;
      var focusableEls = modalContent.querySelectorAll(FOCUSABLE_SELECTOR);
      if (focusableEls.length === 0) return;

      var firstFocusable = focusableEls[0];
      var lastFocusable = focusableEls[focusableEls.length - 1];

      if (e.shiftKey) {
        // Shift+Tab: if at first element, wrap to last
        if (document.activeElement === firstFocusable) {
          e.preventDefault();
          lastFocusable.focus();
        }
      } else {
        // Tab: if at last element, wrap to first
        if (document.activeElement === lastFocusable) {
          e.preventDefault();
          firstFocusable.focus();
        }
      }
    }

    /**
     * Close modal when clicking on the backdrop (outside the modal content).
     * @param {MouseEvent} e
     */
    function handleBackdropClick(e) {
      // Only close if click target is the backdrop itself, not the modal content
      if (e.target === modalEl) {
        close();
      }
    }

    /**
     * Display validation errors inline within the modal.
     * Used when server returns errors after form submission.
     * @param {string[]} errors - Array of error messages
     */
    function showErrors(errors) {
      if (!modalEl) modalEl = document.getElementById('add-member-modal');
      if (!modalEl) return;

      var errorsContainer = modalEl.querySelector('#add-member-modal-errors');
      if (!errorsContainer) return;

      var errorList = errorsContainer.querySelector('ul');
      if (!errorList) return;

      // Clear existing errors
      errorList.innerHTML = '';

      if (errors && errors.length > 0) {
        errors.forEach(function (err) {
          var li = document.createElement('li');
          li.textContent = err;
          errorList.appendChild(li);
        });
        errorsContainer.style.display = '';
      } else {
        errorsContainer.style.display = 'none';
      }
    }

    /**
     * Initialize the Add Member modal.
     * Auto-opens the modal if validation errors are present on page load.
     */
    function init() {
      modalEl = document.getElementById('add-member-modal');
      if (!modalEl) return;

      // Only auto-open if there is an error-summary OUTSIDE the modal (server returned form errors)
      // AND the modal's own error container has content or the page has form validation errors
      var pageErrorSummary = document.querySelector('main > .error-summary[role="alert"], section + .error-summary[role="alert"]');
      if (pageErrorSummary && pageErrorSummary.closest('#add-member-modal') === null) {
        // Collect error messages and display them in the modal
        var errorItems = pageErrorSummary.querySelectorAll('li');
        var errors = [];
        errorItems.forEach(function (li) {
          errors.push(li.textContent);
        });

        // Auto-open modal with errors displayed inline
        open();
        showErrors(errors);

        // Hide the page-level error summary since errors are shown in modal
        pageErrorSummary.style.display = 'none';
      }
    }

    return { open: open, close: close, showErrors: showErrors, init: init };
  })();

  // ─────────────────────────────────────────────────────────────────────────────
  // INITIALIZATION
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Auto-initialize components on DOMContentLoaded.
   * Detects components via data attributes and DOM structure.
   */
  function initApp() {
    // Initialize DataTables
    document.querySelectorAll('[data-datatable]').forEach(function (tableEl) {
      Treasurio.DataTable.init(tableEl);
    });

    // Also support legacy data-table-search attribute (backwards compatible)
    document.querySelectorAll('[data-table-search]').forEach(function (input) {
      const tableId = input.dataset.tableSearch;
      const table = document.getElementById(tableId);
      if (table && !table.hasAttribute('data-datatable')) {
        // Legacy mode: simple search without full DataTable
        input.addEventListener('input', function () {
          const term = input.value.trim().toLowerCase();
          table.querySelectorAll('tbody tr').forEach(function (row) {
            row.hidden = term && !row.textContent.toLowerCase().includes(term);
          });
        });
      }
    });

    // Initialize Sidebar
    Treasurio.Sidebar.init();
    Treasurio.Sidebar.resetForViewport();

    // Hamburger menu toggle
    document.querySelectorAll('[data-sidebar-toggle]').forEach(function (btn) {
      btn.addEventListener('click', function (event) {
        event.preventDefault();
        Treasurio.Sidebar.toggle(event);
      });
    });

    window.addEventListener('resize', debounce(Treasurio.Sidebar.resetForViewport, 100));

    document.querySelectorAll('[data-sidebar-collapse]').forEach(function (button) {
      const collapsed = window.localStorage && window.localStorage.getItem('treasurio-sidebar-collapsed') === 'true';
      document.body.classList.toggle('sidebar-collapsed', collapsed);
      button.setAttribute('aria-pressed', String(collapsed));
      button.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
      button.textContent = collapsed ? '›' : '‹';
      button.addEventListener('click', function () {
        const next = !document.body.classList.contains('sidebar-collapsed');
        document.body.classList.toggle('sidebar-collapsed', next);
        button.setAttribute('aria-pressed', String(next));
        button.setAttribute('aria-label', next ? 'Expand sidebar' : 'Collapse sidebar');
        button.textContent = next ? '›' : '‹';
        if (window.localStorage) window.localStorage.setItem('treasurio-sidebar-collapsed', String(next));
      });
    });

    // Initialize Form Validation
    document.querySelectorAll('form[data-validate]').forEach(function (formEl) {
      Treasurio.FormValidation.init(formEl);
    });

    // Set default date values — use fiscal year if today is outside it
    (function setDefaultDates() {
      var fiscalYear = document.body.dataset.fiscalYear ? parseInt(document.body.dataset.fiscalYear, 10) : null;
      var today = new Date();
      var todayStr = today.toISOString().slice(0, 10);
      var defaultDate = todayStr;

      if (fiscalYear) {
        var todayYear = today.getFullYear();
        if (todayYear !== fiscalYear) {
          // Today is outside the fiscal year — use the last day of the fiscal year
          // or the first day if the fiscal year is in the future
          defaultDate = todayYear > fiscalYear
            ? fiscalYear + '-12-31'
            : fiscalYear + '-01-01';
        }
      }

      document.querySelectorAll('input[type="date"]').forEach(function (input) {
        if (!input.value) input.value = defaultDate;
      });
    })();

    // Print buttons (preserve original functionality)
    document.querySelectorAll('[data-print]').forEach(function (button) {
      button.addEventListener('click', function () { window.print(); });
    });

    // Initialize modal triggers
    document.querySelectorAll('[data-modal-confirm]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        const title = btn.dataset.modalTitle || 'Confirm Action';
        const body = btn.dataset.modalBody || 'Are you sure you want to proceed?';
        const form = btn.closest('form');
        const href = btn.dataset.modalHref || btn.getAttribute('href');

        Treasurio.Modal.open({
          title: title,
          body: body,
          confirmText: btn.dataset.modalConfirmText || 'Confirm',
          confirmClass: btn.dataset.modalConfirmClass || 'btn--danger',
          onConfirm: function () {
            if (form) {
              form.submit();
            } else if (href) {
              window.location.href = href;
            }
          }
        });
      });
    });

    // Show server-set flash toasts
    document.querySelectorAll('[data-toast-flash]').forEach(function (el) {
      const message = el.dataset.toastFlash;
      const type = el.dataset.toastType || 'success';
      if (message) {
        Treasurio.Toast.show(message, type);
      }
      el.remove();
    });

    // Initialize Add Member Modal (auto-opens if validation errors present)
    Treasurio.AddMemberModal.init();
  }

  // Run initialization when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }

  // Expose global helper functions for inline onclick handlers
  window.openAddMemberModal = function () {
    Treasurio.AddMemberModal.open();
  };
  window.closeAddMemberModal = function () {
    Treasurio.AddMemberModal.close();
  };

  // Expose globally
  window.Treasurio = Treasurio;

})(window, document);
