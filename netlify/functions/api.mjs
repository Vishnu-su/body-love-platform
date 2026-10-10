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
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { 'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS', 'access-control-allow-headers': 'content-type,x-admin-key' }, body: '' };
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
      if (event.httpMethod === 'GET' && route === '/admin/movements') {
        const { start, end } = monthRange(event.queryStringParameters?.month);
        const filter = new URLSearchParams({ select: 'id,description,amount_mxn,due_on,paid_at,method,status', due_on: `gte.${start}`, and: `(due_on.lt.${end})`, order: 'due_on.desc,created_at.desc', limit: '100' });
        const [payments, expenses] = await Promise.all([db(`payments?${filter}`), db(`expenses?${filter}`)]);
        const movements = [...(payments || []).map((x) => ({ ...x, direction: 'income' })), ...(expenses || []).map((x) => ({ ...x, direction: 'expense' }))].sort((a, b) => b.due_on.localeCompare(a.due_on));
        return json(200, { movements });
      }
      if (event.httpMethod === 'GET' && route === '/admin/cashflow') {
        const { month } = monthRange(event.queryStringParameters?.month);
        const start = new Date(`${month}-01T00:00:00Z`);
        start.setUTCMonth(start.getUTCMonth() - 5);
        const from = start.toISOString().slice(0, 10);
        const end = new Date(`${month}-01T00:00:00Z`);
        end.setUTCMonth(end.getUTCMonth() + 1);
        const to = end.toISOString().slice(0, 10);
        const filters = new URLSearchParams({ select: 'amount_mxn,paid_at', status: 'eq.paid', paid_at: `gte.${from}T00:00:00Z`, and: `(paid_at.lt.${to}T00:00:00Z)`, limit: '1000' });
        const [payments, expenses] = await Promise.all([db(`payments?${filters}`), db(`expenses?${filters}`)]);
        const totals = Array.from({ length: 6 }, (_, i) => {
          const date = new Date(start); date.setUTCMonth(date.getUTCMonth() + i);
          const key = date.toISOString().slice(0, 7);
          return { month: key, income_mxn: 0, expenses_mxn: 0 };
        });
        for (const row of payments || []) { const item = totals.find((x) => x.month === row.paid_at.slice(0, 7)); if (item) item.income_mxn += Number(row.amount_mxn); }
        for (const row of expenses || []) { const item = totals.find((x) => x.month === row.paid_at.slice(0, 7)); if (item) item.expenses_mxn += Number(row.amount_mxn); }
        return json(200, { months: totals });
      }
      if (event.httpMethod === 'GET' && route === '/admin/bookings') {
        const q = new URLSearchParams({ select: 'id,status,created_at,session_id,members(full_name,phone),class_sessions(starts_at,fitness_classes(name)),attendance(attended,checked_at)', status: 'in.(pending_confirmation,confirmed,attended,no_show)', order: 'created_at.desc', limit: '100' });
        return json(200, { bookings: await db(`bookings?${q}`) || [] });
      }
      if (event.httpMethod === 'POST' && route === '/admin/attendance') {
        const body = parseBody(event);
        if (!body) return fail('El cuerpo debe ser JSON válido.');
        const { booking_id, attended, checked_by = 'Administración' } = body;
        if (typeof booking_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(booking_id) || typeof attended !== 'boolean' || typeof checked_by !== 'string' || checked_by.length > 80) return fail('Datos de asistencia no válidos.');
        const rows = await db('attendance?on_conflict=booking_id&select=id,booking_id,attended,checked_at', { method: 'POST', body: { booking_id, attended, checked_at: new Date().toISOString(), checked_by }, prefer: 'resolution=merge-duplicates,return=representation' });
        await db(`bookings?id=eq.${booking_id}`, { method: 'PATCH', body: { status: attended ? 'attended' : 'no_show' }, prefer: 'return=minimal' });
        return json(200, { attendance: rows?.[0] });
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
      if (event.httpMethod === 'PATCH' && /^\/admin\/movements\/(income|expense)\/[0-9a-f-]{36}$/i.test(route)) {
        const body = parseBody(event);
        if (!body) return fail('El cuerpo debe ser JSON válido.');
        const [, direction, id] = route.match(/^\/admin\/movements\/(income|expense)\/([0-9a-f-]{36})$/i);
        const { concept, amount_mxn, due_on, method, status } = body;
        if (typeof concept !== 'string' || concept.trim().length < 2 || concept.length > 180 || !Number.isFinite(Number(amount_mxn)) || Number(amount_mxn) <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(due_on || '') || !['cash', 'card', 'transfer', 'other'].includes(method) || !['paid', 'pending'].includes(status)) return fail('Revisa concepto, importe, fecha, método y estado.');
        const table = direction === 'income' ? 'payments' : 'expenses';
        const existing = await db(`${table}?${new URLSearchParams({ select: 'id,status', id: `eq.${id}`, limit: '1' })}`);
        if (!existing?.length) return json(404, { error: 'No encontramos ese movimiento.' });
        const row = { description: concept.trim(), amount_mxn: Number(amount_mxn), due_on, method, status, paid_at: status === 'pending' ? null : (existing[0].status === 'paid' ? undefined : new Date().toISOString()) };
        if (row.paid_at === undefined) delete row.paid_at;
        const data = await db(`${table}?id=eq.${id}&select=id,description,amount_mxn,due_on,method,status,paid_at`, { method: 'PATCH', body: row, prefer: 'return=representation' });
        return json(200, { movement: data?.[0] });
      }
    }
    return json(404, { error: 'Ruta no encontrada.' });
  } catch (error) {
    console.error('Body Love API error:', error.message);
    return json(500, { error: 'Error interno al procesar la solicitud.' });
  }
};





