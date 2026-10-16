# HANDYMAN · Inventario y limpieza

Aplicación de inventario con API Node.js y Supabase Auth/Postgres. Las claves secretas no se usan en el navegador; las operaciones de base de datos se ejecutan con el JWT del usuario y respetan RLS.

## Preparar Supabase

1. En Supabase, abre **SQL Editor → New query**.
2. Abre [`supabase/schema.sql`](./supabase/schema.sql) en el proyecto, copia todo su contenido en la consulta y pulsa **Run**. El script crea `public.productos`, `public.salidas_inventario` y `public.bitacora_limpieza`, configura sus permisos y carga tres artículos de ejemplo. También crea la función que descuenta existencias y registra cada salida en una sola operación. La última instrucción actualiza el esquema que usa la API.
3. Confirma que aparecen las tablas `productos`, `salidas_inventario` y `bitacora_limpieza` en **Table Editor**.
4. En **Authentication → Users**, crea los usuarios que podrán iniciar sesión en el portal.
5. Copia `.env.example` como `.env` y revisa la URL y la publishable key del proyecto.

La clave `SUPABASE_SECRET_KEY` no se necesita: la API usa las políticas RLS para limitar las operaciones a usuarios autenticados.

## Ejecutar

Requiere Node.js 22 o superior.

```bash
npm install
npm run dev
```

Abre <http://localhost:3000>. Usa el correo y la contraseña de un usuario creado en Supabase Auth. Para iniciar el servidor sin modo de desarrollo, ejecuta `npm start`.

La API autenticada ofrece `GET` y `POST /api/productos`, además de `PATCH` y `DELETE /api/productos/:id`. Las páginas de Tanuavi y FreshWay consultan esos mismos artículos; sus salidas se guardan en `/api/salidas-inventario` y descuentan el stock general atómicamente. La bitácora permite registrar y consultar limpiezas en `/api/bitacora-limpieza`, descargar reportes `.xlsx` y enviarlos como adjunto de correo. Los filtros opcionales del reporte usan `desde` y `hasta` en formato `AAAA-MM-DD`.

## Configurar el envío de reportes

Para enviar el Excel como adjunto, configura las variables `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` y, opcionalmente, `SMTP_FROM` en `.env`. Usa las credenciales SMTP de tu proveedor de correo; no publiques ni compartas el archivo `.env`. Si SMTP no está configurado, la descarga Excel seguirá disponible y la aplicación mostrará un aviso al intentar enviar el correo.
