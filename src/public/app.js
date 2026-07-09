document.querySelectorAll('[data-table-search]').forEach((input) => {
  const table = document.getElementById(input.dataset.tableSearch);
  if (!table) return;
  input.addEventListener('input', () => {
    const term = input.value.trim().toLowerCase();
    table.querySelectorAll('tbody tr').forEach((row) => {
      row.hidden = term && !row.textContent.toLowerCase().includes(term);
    });
  });
});

document.querySelectorAll('input[type="date"]').forEach((input) => {
  if (!input.value) input.value = new Date().toISOString().slice(0, 10);
});

document.querySelectorAll('[data-print]').forEach((button) => {
  button.addEventListener('click', () => window.print());
});
