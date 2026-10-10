const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const adminKey = process.env.ADMIN_API_KEY;
const configured = Boolean(supabaseUrl && serviceKey);

async function db(path, { method = 'GET', body, prefer } = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      'content-type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) throw new Error(payload?.message || `Supabase HTTP ${response.status}`);
  return payload;
}
const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(body) });
const fail = (message) => json(400, { error: message });
const isAdmin = (event) => Boolean(adminKey && event.headers?.['x-admin-key'] === adminKey);
const parseBody = (event) => { try { return JSON.parse(event.body || '{}'); } catch { return null; } };
const monthRange = (value) => {
  const month = /^\d{4}-\d{2}$/.test(value || '') ? value : new Date().toISOString().slice(0, 7);
  const next = new Date(`${month}-01T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1);
  return { month, start: `${month}-01`, end: next.toISOString().slice(0, 10) };
};
const sum = (rows, status) => (rows || []).filter((r) => !status || r.status === status).reduce((n, r) => n + Number(r.amount_mxn), 0);

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,x-admin-key' }, body: '' };
  if (!configured) return json(503, { error: 'El servidor todavía no está conectado a Supabase.' });
  const route = (event.path || '').replace('/.netlify/functions/api', '').replace(/\/$/, '') || '/';
  try {
    if (event.httpMethod === 'GET' && route === '/classes') {
      const q = new URLSearchParams({ select: 'id,starts_at,capacity,reserved_count,fitness_classes!inner(id,name,category,duration_minutes,price_mxn,active)', starts_at: `gte.${new Date().toISOString()}`, 'fitness_classes.active': 'eq.true', order: 'starts_at.asc', limit: '100' });
      const data = await db(`class_sessions?${q}`);
      return json(200, { sessions: (data || []).map((s) => ({ ...s, available: Math.max(0, s.capacity - s.reserved_count) })) });
    }
    if (event.httpMethod === 'POST' && route === '/bookings') {
      const body = parseBody(event);
      if (!body) return fail('El cuerpo debe ser JSON válido.');
      const { session_id, member_name, phone } = body;
      if (typeof session_id !== 'string' || typeof member_name !== 'string' || member_name.trim().length < 2 || member_name.length > 120) return fail('Indica una sesión y un nombre válido.');
      if (typeof phone !== 'string' || !/^\+?[0-9\s()-]{8,20}$/.test(phone)) return fail('Indica un teléfono válido con código de país.');
      let bookingId;
      try { bookingId = await db('rpc/book_class', { method: 'POST', body: { p_session_id: session_id, p_member_name: member_name.trim(), p_phone: phone.replace(/[^+0-9]/g, '') } }); }
      catch (e) {
        if (e.message.includes('CLASS_FULL')) return json(409, { error: 'La sesión ya no tiene lugares disponibles. Puedes solicitar lista de espera.' });
        if (e.message.includes('SESSION_NOT_FOUND')) return json(404, { error: 'No encontramos esa sesión.' });
        if (e.message.includes('duplicate key')) return json(409, { error: 'Ya existe una reserva para este socio en esa sesión.' });
        throw e;
      }
      return json(201, { booking_id: bookingId, status: 'pending_confirmation', message: 'Solicitud registrada; el estudio debe confirmar el lugar.' });
    }
    if (route.startsWith('/admin/')) {
      if (!isAdmin(event)) return json(401, { error: 'No autorizado.' });
      if (event.httpMethod === 'GET' && route === '/admin/summary') {
        const { start, end, month } = monthRange(event.queryStringParameters?.month);
        const timeStart = `${start}T00:00:00Z`, timeEnd = `${end}T00:00:00Z`;
        const [paymentsDue, paymentsPaid, expensesDue, expensesPaid, sessions, attendance] = await Promise.all([
          db(`payments?${new URLSearchParams({ select: 'amount_mxn,status,due_on,paid_at', due_on: `gte.${start}`, and: `(due_on.lt.${end})` })}`),
          db(`payments?${new URLSearchParams({ select: 'amount_mxn,status,due_on,paid_at', status: 'eq.paid', paid_at: `gte.${timeStart}`, and: `(paid_at.lt.${timeEnd})` })}`),
          db(`expenses?${new URLSearchParams({ select: 'amount_mxn,status,due_on,paid_at', due_on: `gte.${start}`, and: `(due_on.lt.${end})` })}`),
          db(`expenses?${new URLSearchParams({ select: 'amount_mxn,status,due_on,paid_at', status: 'eq.paid', paid_at: `gte.${timeStart}`, and: `(paid_at.lt.${timeEnd})` })}`),
          db(`class_sessions?${new URLSearchParams({ select: 'capacity,reserved_count,starts_at', starts_at: `gte.${timeStart}`, and: `(starts_at.lt.${timeEnd})` })}`),
          db(`attendance?${new URLSearchParams({ select: 'attended,checked_at', checked_at: `gte.${timeStart}`, and: `(checked_at.lt.${timeEnd})` })}`),
        ]);
        const paymentsPending = (paymentsDue || []).filter((r) => r.status === 'pending');
        const expensesPending = (expensesDue || []).filter((r) => r.status === 'pending');
        const cap = sessions.reduce((n, s) => n + s.capacity, 0), reserved = sessions.reduce((n, s) => n + s.reserved_count, 0);
        return json(200, { month, income_paid_mxn: sum(paymentsPaid, 'paid'), income_pending_mxn: sum(paymentsPending, 'pending'), expenses_paid_mxn: sum(expensesPaid, 'paid'), expenses_pending_mxn: sum(expensesPending, 'pending'), net_cashflow_mxn: sum(paymentsPaid, 'paid') - sum(expensesPaid, 'paid'), occupancy_pct: cap ? Math.round(reserved * 100 / cap) : 0, attendance_pct: attendance.length ? Math.round(attendance.filter((a) => a.attended).length * 100 / attendance.length) : 0 });
      }
      if (event.httpMethod === 'POST' && route === '/admin/movements') {
        const body = parseBody(event);
        if (!body) return fail('El cuerpo debe ser JSON válido.');
        const { direction, concept, amount_mxn, due_on, method, status = 'paid' } = body;
        if (!['income', 'expense'].includes(direction) || typeof concept !== 'string' || concept.trim().length < 2 || concept.length > 180 || !Number.isFinite(Number(amount_mxn)) || Number(amount_mxn) <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(due_on || '') || !['cash', 'card', 'transfer', 'other'].includes(method) || !['paid', 'pending'].includes(status)) return fail('Revisa tipo, concepto, importe, fecha, método y estado.');
        const row = { description: concept.trim(), amount_mxn: Number(amount_mxn), due_on, method, status, ...(status === 'paid' ? { paid_at: new Date().toISOString() } : {}) };
        const table = direction === 'income' ? 'payments' : 'expenses';
        const data = await db(`${table}?select=id,description,amount_mxn,due_on,method,status`, { method: 'POST', body: row, prefer: 'return=representation' });
        return json(201, { movement: data?.[0] });
      }
    }
    return json(404, { error: 'Ruta no encontrada.' });
  } catch (error) {
    console.error('Body Love API error:', error.message);
    return json(500, { error: 'Error interno al procesar la solicitud.' });
  }
};





