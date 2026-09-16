const canvas = document.getElementById('canvas');
const game = document.getElementById('game');
const output = document.getElementById('ql-output');
const tables = document.getElementById('tables');
const input = document.getElementById('ql-input');
const toolbar = document.getElementById('toolbar');
const databaseStatus = document.getElementById('database-status');
let runtimeReady = false;

function fitCanvas() {
  if (!runtimeReady) return;
  const availableWidth = Math.max(1, game.clientWidth - 32);
  const headerHeight = document.querySelector('.site-header').offsetHeight;
  const availableHeight = Math.max(1, window.innerHeight - headerHeight - 150);
  const cellSize = Math.max(8, Math.min(15,
    Math.floor(availableWidth / 80), Math.floor(availableHeight / 50)));
  //canvas.style.width = 1280px;//`${80 * cellSize}px`;
  //canvas.style.height = 800px;
}

function runQL(command, logResult = true) {
  if (!runtimeReady) return 'ERR runtime not ready';
  const response = Module.ccall('RED_CLI_Command', 'string', ['string'], [command]);
  if (logResult) console.log(`> ${command}\n${response}`);
  return response;
}

function words(value) {
  if (!value || value.startsWith('ERR') || value === '(empty)') return [];
  return value.trim().split(/\s+/).filter(Boolean);
}

function entityValues(response, tableName, rowId, columns) {
  const prefix = `ESET ${tableName} ${rowId}`;
  if (!response.startsWith(prefix)) return {};

  const tokens = response.slice(prefix.length).trim().split(/\s+/).filter(Boolean);
  const columnNames = new Set(columns);
  const values = {};
  let index = 0;
  while (index < tokens.length) {
    const property = tokens[index++];
    const parts = [];
    while (index < tokens.length && !columnNames.has(tokens[index])) {
      parts.push(tokens[index++]);
    }
    values[property] = parts.join(' ');
  }
  return values;
}

function appendCell(row, tag, value) {
  const cell = document.createElement(tag);
  cell.textContent = value;
  row.append(cell);
}

// Colours are packed RGBA u32s, Render those as 0xRRGGBBAA
const kColorColumns = new Set(['fg', 'bg', 'color']);
function formatCell(column, value) {
  if (value === undefined || value === '') return '';
  if (!kColorColumns.has(column)) return String(value);
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value); // already 0x… or non-numeric
  return '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

// Double-click a value cell to edit it in place; Enter commits via ESET,
// Escape or blur reverts. entityID is the row id (negative for an archetype),
// which ESET accepts directly.
function makeEditable(td, tableName, entityID, column) {
  td.title = 'Double-click to edit';
  td.addEventListener('dblclick', () => {
    if (td.isContentEditable) return;
    const original = td.textContent;
    td.contentEditable = 'true';
    td.classList.add('editing');
    td.focus();
    const commit = () => {
      const value = td.textContent.trim();
      finish();
      if (value === original) return;
      const response = runQL(`ESET ${tableName} ${entityID} ${column} ${value}`);
      if (response.startsWith('ERR')) { td.textContent = original; }
      refreshTables();
    };
    const cancel = () => { td.textContent = original; finish(); };
    const finish = () => {
      td.contentEditable = 'false';
      td.classList.remove('editing');
      td.removeEventListener('keydown', onKey);
      td.removeEventListener('blur', cancel);
    };
    const onKey = event => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); commit(); }
      else if (event.key === 'Escape') { event.preventDefault(); cancel(); }
    };
    td.addEventListener('keydown', onKey);
    td.addEventListener('blur', cancel);
  });
}

function renderDatabaseTable(tableName, columns, instances, archetypes, links) {
  const rows = [...archetypes, ...instances, ...links];
  const details = document.createElement('details');
  details.className = 'db-table';
  const summary = document.createElement('summary');
  summary.append(document.createTextNode(tableName));
  const count = document.createElement('span');
  count.className = 'row-count';
  const counts = [
    `${instances.length} ${instances.length === 1 ? 'instance' : 'instances'}`,
    `${archetypes.length} ${archetypes.length === 1 ? 'archetype' : 'archetypes'}`
  ];
  if (links.length) counts.push(`${links.length} ${links.length === 1 ? 'link' : 'links'}`);
  counts.push(`${columns.length} ${columns.length === 1 ? 'property' : 'properties'}`);
  count.textContent = counts.join(' · ');
  summary.append(count);
  details.append(summary);
  summary.addEventListener('click', event => {
    event.preventDefault();
    const bOpen = !details.open;
    for (const table of tables.querySelectorAll('.db-table')) table.open = false;
    details.open = bOpen;
  });

  if (!columns.length && !rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No active properties, instances, or archetypes.';
    details.append(empty);
    return details;
  }

  const scroll = document.createElement('div');
  scroll.className = 'table-scroll';
  const table = document.createElement('table');
  const head = document.createElement('thead');
  const heading = document.createElement('tr');
  appendCell(heading, 'th', 'id');
  for (const column of columns) appendCell(heading, 'th', column);
  head.append(heading);
  table.append(head);

  const body = document.createElement('tbody');
  const archetypeMap = new Map(archetypes.map(arch => [String(arch.id), arch]));

  // A floating overlay showing the hovered instance's base chain
  const overlay = document.createElement('table');
  overlay.className = 'archetype-overlay';
  overlay.hidden = true;
  const overlayBody = document.createElement('tbody');
  overlay.append(overlayBody);
  const baseIdOf = entry => entry && (entry.values['base'] || entry.values['archetype']);
  const baseChain = entry => {
    const chain = [];
    const seen = new Set();
    let id = baseIdOf(entry);
    while (id && archetypeMap.has(String(id)) && !seen.has(String(id)))
    {
      seen.add(String(id));
      const arch = archetypeMap.get(String(id));
      chain.push(arch);
      id = baseIdOf(arch);
    }
    return chain;
  };
  const buildRow = entry => {
    const tr = document.createElement('tr');
    tr.className = entry.kind;
    appendCell(tr, 'td', entry.id);
    for (const column of columns)
    {
      appendCell(tr, 'td', formatCell(column, entry.values[column]));
    }
    return tr;
  };
  const showPinned = (entry, hoveredTr) => {
    const chain = baseChain(entry);
    if (!chain.length) return;
    overlayBody.replaceChildren(...chain.map(buildRow));
    // Match the hovered row's column widths so the overlay lines up.
    const srcCells = hoveredTr.children;
    for (const tr of overlayBody.children)
    {
      [...tr.children].forEach((td, i) => {
        if (srcCells[i]) td.style.width = `${srcCells[i].getBoundingClientRect().width}px`;
      });
    }
    overlay.hidden = false;
    // Place above the hovered row; if it would overflow the top, place below.
    const scrollRect = scroll.getBoundingClientRect();
    const rowRect = hoveredTr.getBoundingClientRect();
    const overlayH = overlay.getBoundingClientRect().height;
    let top = rowRect.top - scrollRect.top + scroll.scrollTop - overlayH;
    if (rowRect.top - overlayH < scrollRect.top)
    {
      top = rowRect.bottom - scrollRect.top + scroll.scrollTop;
    }
    overlay.style.top = `${top}px`;
    overlay.style.left = `${scroll.scrollLeft}px`;
  };
  const clearPinned = () => { overlay.hidden = true; };

  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = columns.length + 1;
    td.className = 'empty';
    td.textContent = 'Table schema defined (no rows present).';
    tr.append(td);
    body.append(tr);
  } else {
    for (const row of rows) {
      const tr = document.createElement('tr');
      tr.className = row.kind;
      tr.dataset.id = row.id;

      if (row.kind === 'instance') {
        const baseId = row.values['base'] || row.values['archetype'];
        if (baseId) tr.dataset.baseId = baseId;
      }

      appendCell(tr, 'td', row.id);

      for (const column of columns) {
        const td = document.createElement('td');
        let val = row.values[column];
        const isInherited = (row.kind === 'instance' && (val === undefined || val === '') && tr.dataset.baseId);

        if (isInherited) {
          const baseArch = archetypeMap.get(tr.dataset.baseId);
          if (baseArch && baseArch.values[column] !== undefined) {
            val = baseArch.values[column];
            td.className = 'inherited-value';
            td.title = `Inherited from archetype ${tr.dataset.baseId}`;
          }
        }

        td.textContent = formatCell(column, val);
        // Double-click to edit; Enter fires an ESET, Escape/blur cancels.
        makeEditable(td, tableName, row.id, column);
        tr.append(td);
      }

      if (row.kind === 'instance' && tr.dataset.baseId) {
        tr.addEventListener('mouseenter', () => {
          tr.classList.add('highlight-instance');
          showPinned(row, tr);
        });
        tr.addEventListener('mouseleave', () => {
          tr.classList.remove('highlight-instance');
          clearPinned();
        });
      }

      body.append(tr);
    }
  }

  table.append(body);
  scroll.append(table);
  scroll.append(overlay);
  details.append(scroll);
  return details;
}

function refreshTables() {
  if (!runtimeReady) return;
  const openTables = new Set(
    [...tables.querySelectorAll('.db-table[open]')].map(details => details.dataset.table)
  );
  const listResponse = runQL('DLIST', false);
  const tableNames = words(listResponse);
  tables.replaceChildren();

  if (!tableNames.length) {
    databaseStatus.textContent = listResponse.startsWith('ERR')
      ? listResponse
      : 'No active tables. Start a game, then refresh.';
    return;
  }

  let totalInstances = 0;
  let totalArchetypes = 0;
  let totalLinks = 0;
  for (const tableName of tableNames) {
    const columns = words(runQL(`TLIST ${tableName}`, false));
    const rowIds = words(runQL(`TROWS ${tableName}`, false));
    const archetypeIds = words(runQL(`TARCH ${tableName}`, false));
    // Link rows are real table rows now, so TROWS already returns them; a
    // separate LGETALL would list the same rows a second time.
    const links = [];
    const instances = rowIds.map(rowId => ({
      kind: 'instance',
      id: rowId,
      values: entityValues(runQL(`EGETALL ${tableName} ${rowId}`, false), tableName, rowId, columns)
    }));
    const archetypes = archetypeIds.map(rowId => ({
      kind: 'archetype',
      id: rowId,
      values: entityValues(runQL(`EGETALL ${tableName} ${rowId}`, false), tableName, rowId, columns)
    }));
    totalInstances += instances.length;
    totalArchetypes += archetypes.length;
    totalLinks += links.length;
    const details = renderDatabaseTable(tableName, columns, instances, archetypes, links);
    details.dataset.table = tableName;
    details.open = openTables.has(tableName);
    tables.append(details);
  }
  databaseStatus.textContent = `${tableNames.length} tables · ${totalInstances} instances · ${totalArchetypes} archetypes · ${totalLinks} links · browser console: ql("DLIST")`;
}

const commandGroups = [
  ['Entity', [
    ['ESET', 'ESET <table> <entityID> <property> <val> [<property> <val>…]'],
    ['EGET', 'EGET <table> <entityID> <property> [<property>…]'],
    ['EGETALL', 'EGETALL <table> <entityID>'],
    ['EDEL', 'EDEL <table> <entityID>']
  ]],
  ['Link', [
    ['LSET', 'LSET <table> <source> <flavor> <target>'],
    ['LGET', 'LGET <table> <id> [<flavor>]'],
    ['LGETALL', 'LGETALL <table>'],
    ['LDEL', 'LDEL <table> <source> <flavor> <target>']
  ]],
  ['Property', [
    ['PDEF', 'PDEF <table> <property> <type> <storage> [<property> <type> <storage>…]'],
    ['PSET', 'PSET <table> <property> <entityID> <val> [<entityID> <val>…]'],
    ['PGET', 'PGET <table> <property> <entityID> [<entityID>…]']
  ]],
  ['Table', [
    ['TLIST', 'TLIST <table>'],
    ['TROWS', 'TROWS <table>'],
    ['TARCH', 'TARCH <table>']
  ]],
  ['Database', [
    ['DLIST', 'DLIST'],
    ['DSTATS', 'DSTATS'],
    ['DTRACE', 'DTRACE <on|off>'],
    ['DSAVE', 'DSAVE <name> [csv|json]'],
    ['DLOAD', 'DLOAD <name> [csv|json]'],
    ['DCLEAR', 'DCLEAR']
  ]],
  ['Channel', [
    ['CSUB', 'CSUB <entityID> <channel> [<channel>…]'],
    ['CUSUB', 'CUSUB <entityID> [<channel>…]'],
    ['CPUB', 'CPUB <entityID> <channel> <message>'],
    ['CNUMSUB', 'CNUMSUB <channel>'],
    ['CLIST', 'CLIST'],
    ['CRECV', 'CRECV <entityID>']
  ]]
];

function renderCommandReference() {
  const reference = document.getElementById('command-reference');
  commandGroups.forEach(([groupName, commands], groupIndex) => {
    const details = document.createElement('details');
    details.className = 'command-group';
    details.open = groupIndex === 0;
    const summary = document.createElement('summary');
    summary.textContent = `${groupName} commands`;
    details.append(summary);

    const table = document.createElement('table');
    const body = document.createElement('tbody');
    for (const [name, syntax] of commands) {
      const row = document.createElement('tr');
      const nameCell = document.createElement('td');
      const commandName = document.createElement('span');
      commandName.className = 'command-name';
      commandName.textContent = name;
      nameCell.append(commandName);
      row.append(nameCell);
      appendCell(row, 'td', syntax);
      body.append(row);
    }
    table.append(body);
    details.append(table);

    summary.addEventListener('click', event => {
      event.preventDefault();
      const bOpen = !details.open;
      for (const group of reference.querySelectorAll('.command-group')) group.open = false;
      details.open = bOpen;
    });
    reference.append(details);
  });
}

var Module = {
  canvas,
  onDatabaseMessage(message) { console.log(message); },
  onRuntimeInitialized() {
    runtimeReady = true;
    window.ql = function (command) {
      const response = runQL(String(command));
      output.textContent = response || '(ok — no response)';
      refreshTables();
      return response;
    };
    fitCanvas();
    refreshTables();
  }
};

toolbar.addEventListener('submit', event => {
  event.preventDefault();
  const command = input.value.trim();
  if (command) output.textContent = window.ql ? window.ql(command) : 'ERR runtime not ready';
});
for (const eventName of ['keydown', 'keyup', 'keypress']) {
  toolbar.addEventListener(eventName, event => event.stopPropagation());
}
document.getElementById('refresh').addEventListener('click', refreshTables);
//new ResizeObserver(fitCanvas).observe(game);
//new MutationObserver(fitCanvas).observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });
//window.addEventListener('resize', fitCanvas);
window.addEventListener('load', () => { canvas.focus(); });
canvas.addEventListener('click', () => { canvas.focus(); });
renderCommandReference();
