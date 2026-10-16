import 'dotenv/config';

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ExcelJS from 'exceljs';
import nodemailer from 'nodemailer';
import { createContextClient, verifyAuth } from '@supabase/server/core';

const projectUrl = process.env.SUPABASE_URL?.replace(/\/+$/, '');
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const port = Number(process.env.PORT || 3000);

if (!projectUrl || !publishableKey) {
    throw new Error('Configura SUPABASE_URL y SUPABASE_PUBLISHABLE_KEY en el archivo .env.');
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT debe ser un número entre 1 y 65535.');
}

const root = process.cwd();
const staticFiles = new Map([
    ['/', ['login.html', 'text/html; charset=utf-8']],
    ['/login.html', ['login.html', 'text/html; charset=utf-8']],
    ['/sistema.html', ['sistema.html', 'text/html; charset=utf-8']],
    ['/bitacoradelimpieza.html', ['bitacoradelimpieza.html', 'text/html; charset=utf-8']],
    ['/inventarioTanuavi.html', ['inventarioTanuavi.html', 'text/html; charset=utf-8']],
    ['/inventarioFreshWay.html', ['inventarioFreshWay.html', 'text/html; charset=utf-8']],
    ['/inventario-almacen.js', ['inventario-almacen.js', 'text/javascript; charset=utf-8']],
    ['/auth.js', ['auth.js', 'text/javascript; charset=utf-8']]
]);
const productColumns = 'id, codigo, categoria, nombre, cantidad, precio, proveedor';
const outputColumns = 'id, producto_id, almacen, fecha, codigo, nombre, cantidad, solicitante, notas, created_at';
const cleaningColumns = 'id, fecha, almacen, actividades, molecula_ppm, ventiladores, coladeras, lamparas_techo, pisos, estantes_tarimas, materiales_ordenados, senalitica_completa, accion_correctiva, realiza, verifica, observaciones, created_at';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const inventoryWarehouses = new Set(['Tanuavi', 'FreshWay']);
const cleaningChecks = [
    'ventiladores',
    'coladeras',
    'lamparas_techo',
    'pisos',
    'estantes_tarimas',
    'materiales_ordenados',
    'senalitica_completa',
    'accion_correctiva'
];

function sendJson(response, status, body) {
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    response.end(JSON.stringify(body));
}

async function readJson(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 16_384) {
            const error = new Error('La solicitud es demasiado grande.');
            error.status = 413;
            throw error;
        }
        chunks.push(chunk);
    }

    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        const error = new Error('El cuerpo de la solicitud debe ser JSON válido.');
        error.status = 400;
        throw error;
    }
}

function validateProduct(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return 'Envía un producto válido.';
    }

    const textFields = [
        ['codigo', 80],
        ['categoria', 120],
        ['nombre', 200],
        ['proveedor', 200]
    ];
    for (const [field, maxLength] of textFields) {
        if (
            typeof input[field] !== 'string' ||
            input[field].trim().length === 0 ||
            input[field].trim().length > maxLength
        ) {
            return `El campo ${field} no es válido.`;
        }
    }

    if (!Number.isSafeInteger(input.cantidad) || input.cantidad < 0) {
        return 'La cantidad debe ser un número entero igual o mayor que cero.';
    }
    if (
        typeof input.precio !== 'number' ||
        !Number.isFinite(input.precio) ||
        input.precio < 0 ||
        !/^\d{1,10}(\.\d{1,2})?$/.test(String(input.precio))
    ) {
        return 'El precio debe ser un número no negativo con hasta dos decimales.';
    }

    return null;
}

function normalizeProduct(input) {
    return {
        codigo: input.codigo.trim(),
        categoria: input.categoria.trim(),
        nombre: input.nombre.trim(),
        cantidad: input.cantidad,
        precio: input.precio,
        proveedor: input.proveedor.trim()
    };
}

function isValidDate(value) {
    if (typeof value !== 'string' || !datePattern.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateDateRange(url) {
    const from = url.searchParams.get('desde') || '';
    const to = url.searchParams.get('hasta') || '';
    if ((from && !isValidDate(from)) || (to && !isValidDate(to))) {
        return { error: 'Las fechas del reporte deben tener el formato AAAA-MM-DD.' };
    }
    if (from && to && from > to) {
        return { error: 'La fecha inicial no puede ser posterior a la fecha final.' };
    }
    return { from, to };
}

function validateCleaningRecord(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return 'Envía un registro de limpieza válido.';
    }
    if (!isValidDate(input.fecha)) return 'La fecha del registro no es válida.';
    if (!Number.isInteger(input.almacen) || input.almacen < 1 || input.almacen > 3) {
        return 'Selecciona un almacén válido.';
    }
    if (
        !Array.isArray(input.actividades) ||
        input.actividades.length === 0 ||
        input.actividades.some(activity => !['S', 'L', 'SA'].includes(activity)) ||
        new Set(input.actividades).size !== input.actividades.length
    ) {
        return 'Selecciona al menos una actividad válida.';
    }
    if (cleaningChecks.some(field => typeof input[field] !== 'boolean')) {
        return 'Completa todas las respuestas de limpieza.';
    }
    const textFields = [
        ['molecula_ppm', 200, false],
        ['realiza', 120, true],
        ['verifica', 120, false],
        ['observaciones', 2000, false]
    ];
    for (const [field, maxLength, required] of textFields) {
        if (
            typeof input[field] !== 'string' ||
            input[field].trim().length > maxLength ||
            (required && input[field].trim().length === 0)
        ) {
            return `El campo ${field} no es válido.`;
        }
    }
    return null;
}

function normalizeCleaningRecord(input) {
    return {
        fecha: input.fecha,
        almacen: input.almacen,
        actividades: input.actividades,
        molecula_ppm: input.molecula_ppm.trim(),
        ...Object.fromEntries(cleaningChecks.map(field => [field, input[field]])),
        realiza: input.realiza.trim(),
        verifica: input.verifica.trim(),
        observaciones: input.observaciones.trim()
    };
}

function cleaningDatabaseError(response, error) {
    console.error('Error de Supabase en bitacora_limpieza:', {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint
    });
    if (error.code === '42501') {
        sendJson(response, 503, {
            error: 'Supabase rechazó el acceso a public.bitacora_limpieza. Ejecuta supabase/schema.sql en SQL Editor para crear la tabla y sus permisos.'
        });
        return;
    }
    if (error.code === 'PGRST205' || error.code === '42P01') {
        sendJson(response, 503, {
            error: 'Supabase no encuentra public.bitacora_limpieza. Ejecuta supabase/schema.sql en SQL Editor y recarga la página.'
        });
        return;
    }
    if (error.code === 'PGRST204') {
        sendJson(response, 503, {
            error: 'La tabla bitacora_limpieza no coincide con el esquema de la aplicación. Ejecuta supabase/schema.sql en SQL Editor y recarga la página.'
        });
        return;
    }
    sendJson(response, 500, { error: 'No se pudo completar la operación en la bitácora de limpieza.' });
}

async function getCleaningRecords(supabase, range) {
    let query = supabase
        .from('bitacora_limpieza')
        .select(cleaningColumns)
        .order('fecha', { ascending: false })
        .order('created_at', { ascending: false });
    if (range.from) query = query.gte('fecha', range.from);
    if (range.to) query = query.lte('fecha', range.to);
    return query;
}

function cleaningWorkbook(records, range) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Portal de almacén';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Bitácora de limpieza');
    sheet.columns = [
        { header: 'Fecha', key: 'fecha', width: 14 },
        { header: 'Almacén', key: 'almacen', width: 12 },
        { header: 'Actividades', key: 'actividades', width: 18 },
        { header: 'Molécula y PPM', key: 'molecula_ppm', width: 24 },
        { header: 'Ventiladores', key: 'ventiladores', width: 16 },
        { header: 'Coladeras', key: 'coladeras', width: 14 },
        { header: 'Lámparas y techo', key: 'lamparas_techo', width: 18 },
        { header: 'Pisos', key: 'pisos', width: 12 },
        { header: 'Estantes o tarimas', key: 'estantes_tarimas', width: 20 },
        { header: 'Materiales ordenados/protegidos', key: 'materiales_ordenados', width: 32 },
        { header: 'Señalítica completa', key: 'senalitica_completa', width: 20 },
        { header: 'Acción correctiva', key: 'accion_correctiva', width: 20 },
        { header: 'Observaciones', key: 'observaciones', width: 42 },
        { header: 'Quién realiza', key: 'realiza', width: 20 },
        { header: 'Quién verifica', key: 'verifica', width: 20 },
        { header: 'Registrado', key: 'created_at', width: 24 }
    ];
    sheet.addRows(records.map(record => ({
        ...record,
        actividades: record.actividades.join(', '),
        ventiladores: record.ventiladores ? 'Sí' : 'No',
        coladeras: record.coladeras ? 'Sí' : 'No',
        lamparas_techo: record.lamparas_techo ? 'Sí' : 'No',
        pisos: record.pisos ? 'Sí' : 'No',
        estantes_tarimas: record.estantes_tarimas ? 'Sí' : 'No',
        materiales_ordenados: record.materiales_ordenados ? 'Sí' : 'No',
        senalitica_completa: record.senalitica_completa ? 'Sí' : 'No',
        accion_correctiva: record.accion_correctiva ? 'Sí' : 'No',
        created_at: new Date(record.created_at).toLocaleString('es-MX')
    })));
    sheet.autoFilter = { from: 'A1', to: 'P1' };
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E4620' } };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    workbook.subject = range.from || range.to
        ? `Registros de limpieza del ${range.from || 'inicio'} al ${range.to || 'hoy'}`
        : 'Registros de limpieza';
    return workbook;
}

async function sendCleaningWorkbook(records, range, recipient) {
    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD } = process.env;
    const port = Number(SMTP_PORT || 587);
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD || !Number.isInteger(port) || port < 1 || port > 65535) {
        const error = new Error('El envío por correo no está configurado. Define SMTP_HOST, SMTP_PORT, SMTP_USER y SMTP_PASSWORD en .env.');
        error.status = 503;
        throw error;
    }

    const workbook = cleaningWorkbook(records, range);
    const attachment = Buffer.from(await workbook.xlsx.writeBuffer());
    const transport = nodemailer.createTransport({
        host: SMTP_HOST,
        port,
        secure: process.env.SMTP_SECURE === 'true' || port === 465,
        auth: { user: SMTP_USER, pass: SMTP_PASSWORD }
    });
    await transport.sendMail({
        from: process.env.SMTP_FROM || SMTP_USER,
        to: recipient,
        subject: 'Reporte de bitácora de limpieza',
        text: `Adjuntamos el reporte de limpieza solicitado. Registros: ${records.length}.`,
        attachments: [{
            filename: 'reporte-bitacora-limpieza.xlsx',
            content: attachment,
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        }]
    });
}

function databaseError(response, error) {
    console.error('Error de Supabase:', {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint
    });
    if (error.code === '23505') {
        sendJson(response, 409, { error: 'Ya existe un artículo con ese código.' });
        return;
    }
    if (error.code === '42501') {
        const deniedTable = error.message?.includes('salidas_inventario')
            ? 'public.salidas_inventario'
            : 'public.productos';
        sendJson(response, 503, {
            error: `Supabase rechazó el acceso a ${deniedTable}. Ejecuta de nuevo completo el archivo supabase/schema.sql en SQL Editor; crea los permisos y las políticas RLS para usuarios autenticados.`
        });
        return;
    }
    if (error.code === 'PGRST205' || error.code === '42P01') {
        const missingTable = error.message?.includes('salidas_inventario')
            ? 'public.salidas_inventario'
            : 'public.productos';
        sendJson(response, 503, {
            error: `Supabase no encuentra la tabla ${missingTable}. En Supabase abre SQL Editor, ejecuta el contenido de supabase/schema.sql y luego recarga esta página.`
        });
        return;
    }
    if (error.code === 'PGRST204') {
        sendJson(response, 503, {
            error: 'La tabla productos no coincide con el esquema de la aplicación. Ejecuta de nuevo completo el archivo supabase/schema.sql en SQL Editor y recarga esta página.'
        });
        return;
    }
    if (error.code === 'PGRST202') {
        sendJson(response, 503, {
            error: 'Supabase no encuentra la función para registrar salidas. Ejecuta de nuevo completo el archivo supabase/schema.sql en SQL Editor y recarga esta página.'
        });
        return;
    }
    sendJson(response, 500, { error: 'No se pudo completar la operación en la base de datos.' });
}

async function handleApi(request, response, url) {
    const headers = new Headers();
    if (request.headers.authorization) {
        headers.set('authorization', request.headers.authorization);
    }
    const authRequest = new Request(url, {
        method: request.method,
        headers
    });
    const { data: auth, error: authError } = await verifyAuth(authRequest, {
        auth: 'user',
        issuer: `${projectUrl}/auth/v1`
    });

    if (authError) {
        sendJson(response, authError.status || 401, { error: 'Inicia sesión para acceder al inventario.' });
        return;
    }

    const supabase = createContextClient({ auth: { token: auth.token } });
    const pathname = url.pathname;

    if (pathname === '/api/bitacora-limpieza' && request.method === 'GET') {
        const range = validateDateRange(url);
        if (range.error) {
            sendJson(response, 400, { error: range.error });
            return;
        }
        const { data, error } = await getCleaningRecords(supabase, range);
        if (error) return cleaningDatabaseError(response, error);
        sendJson(response, 200, data);
        return;
    }

    if (pathname === '/api/bitacora-limpieza' && request.method === 'POST') {
        const input = await readJson(request);
        const validationError = validateCleaningRecord(input);
        if (validationError) {
            sendJson(response, 400, { error: validationError });
            return;
        }
        const { data, error } = await supabase
            .from('bitacora_limpieza')
            .insert(normalizeCleaningRecord(input))
            .select(cleaningColumns)
            .single();
        if (error) return cleaningDatabaseError(response, error);
        sendJson(response, 201, data);
        return;
    }

    if (
        (pathname === '/api/bitacora-limpieza/reporte.xlsx' && request.method === 'GET') ||
        (pathname === '/api/bitacora-limpieza/correo' && request.method === 'POST')
    ) {
        const range = validateDateRange(url);
        if (range.error) {
            sendJson(response, 400, { error: range.error });
            return;
        }
        let recipient = '';
        if (pathname.endsWith('/correo')) {
            const input = await readJson(request);
            recipient = typeof input.correo === 'string' ? input.correo.trim() : '';
            if (recipient.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
                sendJson(response, 400, { error: 'Escribe un correo electrónico válido.' });
                return;
            }
        }
        const { data, error } = await getCleaningRecords(supabase, range);
        if (error) return cleaningDatabaseError(response, error);
        if (pathname.endsWith('/correo')) {
            try {
                await sendCleaningWorkbook(data, range, recipient);
            } catch (mailError) {
                if (mailError.status) throw mailError;
                console.error('No se pudo enviar el reporte de limpieza:', mailError.message);
                sendJson(response, 502, { error: 'No se pudo enviar el correo. Verifica la configuración SMTP e inténtalo de nuevo.' });
                return;
            }
            sendJson(response, 200, { message: `Reporte enviado a ${recipient}.` });
            return;
        }
        const workbook = cleaningWorkbook(data, range);
        const file = Buffer.from(await workbook.xlsx.writeBuffer());
        const dateSuffix = range.from || range.to
            ? `-${range.from || 'inicio'}-${range.to || 'hoy'}`
            : '';
        response.writeHead(200, {
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename="reporte-bitacora-limpieza${dateSuffix}.xlsx"`,
            'Content-Length': file.length,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        });
        response.end(file);
        return;
    }

    if (pathname === '/api/productos' && request.method === 'GET') {
        const { data, error } = await supabase
            .from('productos')
            .select(productColumns)
            .order('codigo', { ascending: true });
        if (error) return databaseError(response, error);
        sendJson(response, 200, data);
        return;
    }

    if (pathname === '/api/productos' && request.method === 'POST') {
        const input = await readJson(request);
        const validationError = validateProduct(input);
        if (validationError) {
            sendJson(response, 400, { error: validationError });
            return;
        }

        const { data, error } = await supabase
            .from('productos')
            .insert(normalizeProduct(input))
            .select(productColumns)
            .single();
        if (error) return databaseError(response, error);
        sendJson(response, 201, data);
        return;
    }

    if (pathname === '/api/salidas-inventario' && request.method === 'GET') {
        const almacen = url.searchParams.get('almacen');
        if (!inventoryWarehouses.has(almacen)) {
            sendJson(response, 400, { error: 'El almacén debe ser Tanuavi o FreshWay.' });
            return;
        }
        const { data, error } = await supabase
            .from('salidas_inventario')
            .select(outputColumns)
            .eq('almacen', almacen)
            .order('fecha', { ascending: false })
            .order('created_at', { ascending: false });
        if (error) return databaseError(response, error);
        sendJson(response, 200, data);
        return;
    }

    if (pathname === '/api/salidas-inventario' && request.method === 'POST') {
        const input = await readJson(request);
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
            sendJson(response, 400, { error: 'Envía una salida de inventario válida.' });
            return;
        }
        if (!inventoryWarehouses.has(input.almacen)) {
            sendJson(response, 400, { error: 'El almacén debe ser Tanuavi o FreshWay.' });
            return;
        }
        if (!uuidPattern.test(input.producto_id || '')) {
            sendJson(response, 400, { error: 'Selecciona un artículo válido.' });
            return;
        }
        if (!isValidDate(input.fecha)) {
            sendJson(response, 400, { error: 'La fecha de salida no es válida.' });
            return;
        }
        if (!Number.isSafeInteger(input.cantidad) || input.cantidad < 1) {
            sendJson(response, 400, { error: 'La cantidad debe ser un número entero mayor que cero.' });
            return;
        }
        if (
            typeof input.solicitante !== 'string' ||
            input.solicitante.trim().length === 0 ||
            input.solicitante.trim().length > 120
        ) {
            sendJson(response, 400, { error: 'Escribe un solicitante válido (máximo 120 caracteres).' });
            return;
        }
        if (typeof input.notas !== 'string' || input.notas.length > 2000) {
            sendJson(response, 400, { error: 'Las observaciones no pueden superar 2000 caracteres.' });
            return;
        }

        const { data, error } = await supabase.rpc('registrar_salida_inventario', {
            p_producto_id: input.producto_id,
            p_almacen: input.almacen,
            p_fecha: input.fecha,
            p_cantidad: input.cantidad,
            p_solicitante: input.solicitante.trim(),
            p_notas: input.notas.trim()
        });
        if (error) {
            if (error.code === 'P0001' && error.message === 'STOCK_INSUFICIENTE') {
                sendJson(response, 409, { error: 'No hay suficiente stock para registrar esta salida.' });
                return;
            }
            return databaseError(response, error);
        }
        sendJson(response, 201, data);
        return;
    }

    const match = pathname.match(/^\/api\/productos\/([^/]+)$/);
    if (!match) {
        sendJson(response, 404, { error: 'Ruta de API no encontrada.' });
        return;
    }
    if (!uuidPattern.test(match[1])) {
        sendJson(response, 400, { error: 'El identificador del artículo no es válido.' });
        return;
    }

    if (request.method === 'PATCH') {
        const input = await readJson(request);
        const validationError = validateProduct(input);
        if (validationError) {
            sendJson(response, 400, { error: validationError });
            return;
        }

        const { data, error } = await supabase
            .from('productos')
            .update(normalizeProduct(input))
            .eq('id', match[1])
            .select(productColumns)
            .maybeSingle();
        if (error) return databaseError(response, error);
        if (!data) {
            sendJson(response, 404, { error: 'El artículo ya no existe.' });
            return;
        }
        sendJson(response, 200, data);
        return;
    }

    if (request.method === 'DELETE') {
        const { data, error } = await supabase
            .from('productos')
            .delete()
            .eq('id', match[1])
            .select('id')
            .maybeSingle();
        if (error) return databaseError(response, error);
        if (!data) {
            sendJson(response, 404, { error: 'El artículo ya no existe.' });
            return;
        }
        sendJson(response, 200, { id: data.id });
        return;
    }

    sendJson(response, 405, { error: 'Método no permitido.' });
}

const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

    try {
        if (url.pathname === '/api/config' && request.method === 'GET') {
            sendJson(response, 200, { supabaseUrl: projectUrl, publishableKey });
            return;
        }

        if (url.pathname.startsWith('/api/')) {
            await handleApi(request, response, url);
            return;
        }

        if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, { Allow: 'GET, HEAD' });
            response.end();
            return;
        }

        const file = staticFiles.get(url.pathname);
        if (!file) {
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('No encontrado.');
            return;
        }

        const content = await readFile(resolve(root, file[0]));
        response.writeHead(200, {
            'Content-Type': file[1],
            'X-Content-Type-Options': 'nosniff'
        });
        response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
        if (error.status) {
            sendJson(response, error.status, { error: error.message });
            return;
        }
        console.error('Error al atender la solicitud:', error.message);
        if (!response.headersSent) {
            sendJson(response, 500, { error: 'Error interno del servidor.' });
        } else {
            response.end();
        }
    }
});

server.listen(port, () => {
    console.log(`Servidor listo en http://localhost:${port}`);
});
