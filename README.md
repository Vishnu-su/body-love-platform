# Body Love · starter de servidor y base de datos

Este starter conecta la demo de Body Love con una base PostgreSQL de Supabase y funciones de servidor en Netlify. Los datos iniciales son de ejemplo. No incluye la integración de WhatsApp todavía.

## Qué incluye

- `supabase/schema.sql`: socios, clases, sesiones, reservas, pagos, gastos y asistencia; control atómico de cupos al reservar.
- `netlify/functions/api.mjs`: consulta de clases, reserva, resumen contable protegido y registro de movimientos protegido.
- `netlify.toml`: configuración para desplegar las funciones de Netlify.
- `.env.example`: nombres de variables necesarias; no contiene secretos.

## Preparación

1. En Supabase crea un proyecto PostgreSQL para Body Love.
2. Abre **SQL Editor**, pega `supabase/schema.sql` y ejecútalo.
3. En Netlify conecta un repositorio Git que contenga este proyecto. El despliegue por arrastrar y soltar publica archivos estáticos, pero no pone en marcha estas funciones.
4. En la configuración del sitio de Netlify, añade estas variables privadas:
   - `SUPABASE_URL`: URL del proyecto.
   - `SUPABASE_SERVICE_ROLE_KEY`: clave `service_role` de Supabase. Guárdala solo en Netlify; nunca en HTML ni JavaScript del navegador.
   - `ADMIN_API_KEY`: una clave larga y aleatoria para proteger las funciones administrativas.
5. Despliega el sitio. La función quedará disponible bajo `/.netlify/functions/api`.

## Rutas preparadas

- `GET /.netlify/functions/api/classes` — consulta sesiones futuras y cupos disponibles.
- `POST /.netlify/functions/api/bookings` — crea una solicitud de reserva; descuenta el cupo en una transacción de base de datos.
- `GET /.netlify/functions/api/admin/summary?month=2026-10` — resumen de entradas, salidas y pagos pendientes. Requiere encabezado `x-admin-key`.
- `POST /.netlify/functions/api/admin/movements` — registra una entrada o salida. Requiere encabezado `x-admin-key`.

Ejemplo de reserva:

```json
{
  "session_id": "UUID_DE_LA_SESION",
  "member_name": "Nombre del socio",
  "phone": "+524441234567"
}
```

Las funciones responden con JSON. El endpoint público de clases solo devuelve agenda; los datos financieros y movimientos requieren la clave administrativa.

## Seguridad y límites

- No almacenes CLABE, números completos de tarjeta, contraseñas ni tokens en la página pública.
- El resumen financiero exige clave privada. Para una administración multiusuario, reemplaza `ADMIN_API_KEY` por inicio de sesión y roles.
- Antes de recibir clientes reales agrega consentimiento/aviso de privacidad, límites contra abuso, bitácora, copias de seguridad y política de cancelación.
- La página `site/index.html` ya consulta la agenda y envía reservas al servidor cuando está desplegado y conectado. Las cifras financieras del panel siguen siendo de muestra hasta añadir autenticación administrativa y conectar el panel con `/admin/summary`.
- WhatsApp se integra después mediante la API oficial y un webhook HTTPS; no se automatiza WhatsApp Web.

