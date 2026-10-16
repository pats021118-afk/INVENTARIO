const warehouse = document.body.dataset.warehouse;
const warehouseHistoryLabel = warehouse === 'Tanuavi' ? 'Tanuavi' : 'FreshWay';
let inventory = [];
let outputHistory = [];

const inventoryMessage = document.getElementById('inventory-message');
const inventoryBody = document.getElementById('inventoryTableBody');
const outputForm = document.getElementById('outputForm');
const outputButton = outputForm.querySelector('button[type="submit"]');

function setMessage(message = '') {
    inventoryMessage.textContent = message;
    inventoryMessage.hidden = !message;
}

function localDate() {
    const now = new Date();
    const offset = now.getTimezoneOffset() * 60_000;
    return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function refreshDate() {
    document.getElementById('current-date').textContent = new Intl.DateTimeFormat('es-MX', {
        day: '2-digit',
        month: 'long',
        year: 'numeric'
    }).format(new Date());
}

function getStatus(quantity) {
    if (quantity === 0) {
        return { label: 'Agotado', className: 'bg-red-100 text-red-800' };
    }
    if (quantity <= 10) {
        return { label: 'Bajo', className: 'bg-yellow-100 text-yellow-800' };
    }
    return { label: 'Normal', className: 'bg-green-100 text-green-800' };
}

function renderInventoryTable() {
    const query = document.getElementById('searchInventory').value.trim().toLocaleLowerCase('es-MX');
    const visibleProducts = inventory.filter(product =>
        [product.codigo, product.nombre, product.categoria, product.proveedor]
            .some(value => value.toLocaleLowerCase('es-MX').includes(query))
    );
    inventoryBody.replaceChildren();

    if (visibleProducts.length === 0) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 5;
        cell.className = 'p-4 text-center text-gray-400';
        cell.textContent = query
            ? 'No hay artículos que coincidan con la búsqueda.'
            : 'No hay artículos registrados en el inventario general.';
        row.appendChild(cell);
        inventoryBody.appendChild(row);
    } else {
        visibleProducts.forEach(product => {
            const row = document.createElement('tr');
            row.className = 'hover:bg-gray-50';
            const status = getStatus(product.cantidad);
            const values = [
                [product.codigo, 'p-3 font-mono font-medium text-xs text-gray-500'],
                [product.nombre, 'p-3 font-semibold text-gray-800'],
                [product.categoria, 'p-3'],
                [product.cantidad, `p-3 text-right font-bold ${product.cantidad <= 10 ? 'text-red-600' : 'text-gray-800'}`]
            ];

            values.forEach(([value, className]) => {
                const cell = document.createElement('td');
                cell.className = className;
                cell.textContent = String(value);
                row.appendChild(cell);
            });

            const statusCell = document.createElement('td');
            statusCell.className = 'p-3 text-center';
            const badge = document.createElement('span');
            badge.className = `rounded-full px-2 py-1 text-xs font-semibold ${status.className}`;
            badge.textContent = status.label;
            statusCell.appendChild(badge);
            row.appendChild(statusCell);
            inventoryBody.appendChild(row);
        });
    }

    document.getElementById('stat-total-items').textContent = inventory.length;
    document.getElementById('stat-low-stock').textContent =
        inventory.filter(product => product.cantidad <= 10).length;

    const select = document.getElementById('outMaterial');
    const selectedId = select.value;
    select.replaceChildren(new Option('-- Seleccionar --', ''));
    inventory.forEach(product => {
        const option = new Option(
            `[${product.codigo}] ${product.nombre} (Stock: ${product.cantidad})`,
            product.id
        );
        select.add(option);
    });
    select.value = selectedId;
    updateSelectedStock();
}

function renderHistoryTable() {
    const tbody = document.getElementById('historyTableBody');
    tbody.replaceChildren();

    if (outputHistory.length === 0) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 5;
        cell.className = 'p-4 text-center text-gray-400';
        cell.textContent = `No hay salidas registradas en ${warehouseHistoryLabel}.`;
        row.appendChild(cell);
        tbody.appendChild(row);
    } else {
        outputHistory.forEach(record => {
            const row = document.createElement('tr');
            row.className = 'hover:bg-gray-50';
            [
                [record.fecha, 'p-3 text-xs text-gray-500'],
                [`${record.nombre} (${record.codigo})`, 'p-3'],
                [`-${record.cantidad}`, 'p-3 text-center font-bold text-red-600'],
                [record.solicitante, 'p-3'],
                [record.notas || '-', 'p-3 text-xs text-gray-500']
            ].forEach(([value, className]) => {
                const cell = document.createElement('td');
                cell.className = className;
                cell.textContent = String(value);
                row.appendChild(cell);
            });
            tbody.appendChild(row);
        });
    }

    document.getElementById('stat-total-outputs').textContent = outputHistory.length;
}

async function loadInventory() {
    inventory = await window.supabaseAuth.request('/api/productos');
    renderInventoryTable();
}

async function loadOutputHistory() {
    outputHistory = await window.supabaseAuth.request(
        `/api/salidas-inventario?almacen=${encodeURIComponent(warehouse)}`
    );
    renderHistoryTable();
}

function updateSelectedStock() {
    const product = inventory.find(item => item.id === document.getElementById('outMaterial').value);
    document.getElementById('outStockCurrent').value = product ? product.cantidad : 0;
    document.getElementById('outQuantity').max = product ? product.cantidad : '';
}

function filterInventory() {
    renderInventoryTable();
}

function switchTab(tabName) {
    ['inventory', 'history', 'manage'].forEach(name => {
        document.getElementById(`tab-${name}`).classList.toggle('hidden', name !== tabName);
        const button = document.getElementById(`tab-${name}-btn`);
        button.className = name === tabName
            ? 'flex-1 border-b-2 border-green-600 px-4 py-3 font-semibold text-green-700 flex justify-center items-center gap-2'
            : 'flex-1 px-4 py-3 font-medium text-gray-500 hover:text-gray-700 flex justify-center items-center gap-2';
    });
}

async function exportHistoryCSV() {
    if (outputHistory.length === 0) {
        window.alert('No hay salidas para exportar.');
        return;
    }
    const quote = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const rows = [
        ['Fecha', 'Código', 'Material', 'Cantidad', 'Solicitante', 'Notas'],
        ...outputHistory.map(record => [
            record.fecha,
            record.codigo,
            record.nombre,
            record.cantidad,
            record.solicitante,
            record.notas
        ])
    ];
    const content = rows.map(row => row.map(quote).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['\uFEFF', content], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `Salidas_${warehouseHistoryLabel}_${localDate()}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

document.getElementById('outMaterial').addEventListener('change', updateSelectedStock);
document.getElementById('searchInventory').addEventListener('input', filterInventory);

outputForm.addEventListener('submit', async event => {
    event.preventDefault();
    const productId = document.getElementById('outMaterial').value;
    const product = inventory.find(item => item.id === productId);
    const quantity = Number(document.getElementById('outQuantity').value);
    if (!product || !Number.isSafeInteger(quantity) || quantity < 1) {
        setMessage('Selecciona un artículo y una cantidad válida para registrar la salida.');
        return;
    }

    outputButton.disabled = true;
    setMessage();
    try {
        await window.supabaseAuth.request('/api/salidas-inventario', {
            method: 'POST',
            body: {
                producto_id: product.id,
                almacen: warehouse,
                fecha: document.getElementById('outDate').value,
                cantidad: quantity,
                solicitante: document.getElementById('outRequestedBy').value.trim(),
                notas: document.getElementById('outNotes').value.trim()
            }
        });
        outputForm.reset();
        document.getElementById('outDate').value = localDate();
        await Promise.all([loadInventory(), loadOutputHistory()]);
        setMessage('Salida registrada y existencias actualizadas en el inventario general.');
    } catch (error) {
        setMessage(error.message);
        if (error.message.includes('suficiente stock')) {
            loadInventory().catch(refreshError => setMessage(`${error.message} ${refreshError.message}`));
        }
    } finally {
        outputButton.disabled = false;
    }
});

document.getElementById('logout-button').addEventListener('click', async () => {
    try {
        await window.supabaseAuth.signOut();
        window.location.assign('/login.html');
    } catch (error) {
        setMessage(error.message);
    }
});

refreshDate();
document.getElementById('outDate').value = localDate();
Promise.all([loadInventory(), loadOutputHistory()]).catch(error => setMessage(error.message));
window.addEventListener('focus', () => {
    Promise.all([loadInventory(), loadOutputHistory()]).catch(error => setMessage(error.message));
});
window.setInterval(() => {
    Promise.all([loadInventory(), loadOutputHistory()]).catch(error => setMessage(error.message));
}, 30_000);
