require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const PORT = process.env.PORT || 3000;
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const MAX_DIA = parseInt(process.env.MAX_MENSAJES_DIA || '400', 10);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const F_RESERVAS = path.join(DATA_DIR, 'reservas.json');
const F_LLAMADAS = path.join(DATA_DIR, 'llamadas.json');
const F_PEDIDOS = path.join(DATA_DIR, 'pedidos.json');

function leerJSON(archivo, porDefecto) {
  try { return JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch { return porDefecto; }
}
function guardarJSON(archivo, datos) {
  fs.writeFileSync(archivo, JSON.stringify(datos, null, 2));
}
function cargarNegocio() {
  return leerJSON(path.join(__dirname, 'menu.json'), { nombre: 'Restaurante', menu: [] });
}

/* ---------- Seguridad: código de acceso y límite diario ---------- */
function iguales(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function auth(req, res, next) {
  if (!ACCESS_CODE) return next();
  if (iguales(String(req.headers['x-access-code'] || ''), ACCESS_CODE)) return next();
  res.status(401).json({ error: 'Código de acceso incorrecto.' });
}
const diaActual = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
let contador = { dia: diaActual(), n: 0 };
function sumarUso() {
  if (contador.dia !== diaActual()) contador = { dia: diaActual(), n: 0 };
  if (contador.n >= MAX_DIA) return false;
  contador.n++;
  return true;
}

/* ---------- Etiquetas del agente y pedidos ---------- */
function extraerEtiqueta(texto, nombre) {
  const marca = '[' + nombre + ']';
  const i = texto.indexOf(marca);
  if (i < 0) return null;
  const ini = texto.indexOf('{', i + marca.length);
  if (ini < 0) return null;
  let prof = 0, enStr = false, esc = false;
  for (let k = ini; k < texto.length; k++) {
    const c = texto[k];
    if (enStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') enStr = false; continue; }
    if (c === '"') enStr = true;
    else if (c === '{') prof++;
    else if (c === '}') { prof--; if (prof === 0) return { json: texto.slice(ini, k + 1), inicio: i, fin: k + 1 }; }
  }
  return null;
}
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function buscarPlato(nombre) {
  const n = norm(nombre);
  if (!n) return null;
  const platos = (cargarNegocio().menu || []).flatMap(c => c.platos || []);
  return platos.find(p => norm(p.nombre) === n)
    || platos.find(p => norm(p.nombre).includes(n) || n.includes(norm(p.nombre))) || null;
}

function armarPedido(raw) {
  const neg = cargarNegocio();
  const costo = (neg.domicilio && neg.domicilio.costo) || 0;
  let subtotal = 0, revisar = false;
  const items = (Array.isArray(raw.items) ? raw.items : []).map(it => {
    const plato = buscarPlato(it.nombre);
    const cantidad = Math.max(1, parseInt(it.cantidad, 10) || 1);
    if (!plato) { revisar = true; return { nombre: String(it.nombre || '?').slice(0, 80), cantidad, precio: 0 }; }
    subtotal += plato.precio * cantidad;
    return { nombre: plato.nombre, cantidad, precio: plato.precio };
  });
  const t = (v, n) => String(v || '').slice(0, n);
  return {
    id: crypto.randomUUID(), creado: new Date().toISOString(), estado: 'nuevo',
    nombre: t(raw.nombre, 80), telefono: t(raw.telefono, 30), direccion: t(raw.direccion, 160),
    pago: t(raw.pago, 40), notas: t(raw.notas, 200),
    items, subtotal, domicilio: costo, total: subtotal + costo, revisar: revisar || !items.length
  };
}
const ESTADOS = ['nuevo', 'preparando', 'en camino', 'entregado'];

/* ---------- IA ---------- */
async function gemini(instrucciones, contents, temperatura) {
  if (!API_KEY) throw new Error('Falta la clave de IA. Configure GEMINI_API_KEY.');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: instrucciones }] },
      contents,
      generationConfig: { temperature: temperatura, maxOutputTokens: 1024 }
    })
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data.error && data.error.message) || 'Error al consultar la IA.');
  const partes = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  return partes.map(p => p.text || '').join('').trim();
}

function instruccionesAgente() {
  const n = cargarNegocio();
  const hoy = new Date().toLocaleDateString('es-CO', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Bogota'
  });
  return `Eres la recepcionista virtual del restaurante "${n.nombre}". Atiendes llamadas de clientes en español colombiano, con trato cálido, amable y profesional (usa "usted" salvo que el cliente tutee).

REGLAS DE ESTILO
- Tus respuestas se van a HABLAR en una llamada: máximo 2 o 3 frases cortas, sin listas, sin emojis, sin símbolos.
- Di los precios en palabras naturales (por ejemplo "cuarenta y dos mil pesos").
- Ya saludaste al inicio de la llamada; no vuelvas a saludar ni a presentarte.

REGLAS DE CONTENIDO
- Responde SOLO con la información de abajo. Si no la tienes, no inventes: di que una persona del equipo le confirma y ofrece tomar su nombre y teléfono.
- Los celulares colombianos tienen 10 dígitos y empiezan por 3. Si el cliente da un teléfono con otra cantidad de dígitos, pídele amablemente que lo repita antes de continuar.
- No ofreces pedidos para llevar. Si el cliente quiere pedir platos, pregunta si es para domicilio o si prefiere reservar una mesa.
- Si el cliente está molesto o pide hablar con una persona, ofrece tomar sus datos para que lo llamen.

RESERVAS
- Para reservar necesitas: nombre, fecha, hora, número de personas y teléfono. Pídelos de a uno o dos por vez, no todos juntos.
- Verifica que la fecha y hora estén dentro del horario de atención.
- Antes de cerrar, repite los datos y pregunta si los confirma.
- SOLO cuando el cliente confirme, termina tu mensaje con esta línea exacta (no la leas en voz alta, el sistema la procesa):
[RESERVA]{"nombre":"...","fecha":"AAAA-MM-DD","hora":"HH:MM","personas":0,"telefono":"..."}

DOMICILIOS
- Solo se entrega en las zonas indicadas en "domicilio" y el costo de envío es fijo; dilo en palabras (por ejemplo "tres mil pesos").
- Para tomar un domicilio necesitas: los platos con la cantidad de cada uno, la dirección completa (calle, número y barrio), el nombre, el teléfono y la forma de pago. Pídelos de a poco, no todos juntos.
- Usa los nombres EXACTOS de los platos del menú. Si el cliente pide algo que no está, dilo y ofrece alternativas.
- Antes de cerrar, repite TODO el pedido: cada plato con su cantidad, la dirección, el teléfono, el subtotal, el costo del domicilio y el total (suma los precios del menú y el envío), y pregunta si lo confirma.
- SOLO cuando el cliente confirme, termina tu mensaje con esta línea exacta (no la leas en voz alta, el sistema la procesa):
[PEDIDO]{"nombre":"...","telefono":"...","direccion":"...","pago":"...","notas":"","items":[{"nombre":"nombre exacto del plato","cantidad":1}]}
- Después de confirmar, informa el tiempo estimado de entrega.

Hoy es ${hoy} (zona horaria de Colombia).

INFORMACIÓN DEL RESTAURANTE
${JSON.stringify(n, null, 2)}`;
}

/* ---------- Rutas ---------- */
app.get('/api/info', (req, res) => {
  const n = cargarNegocio();
  res.json({
    nombre: n.nombre,
    protegido: Boolean(ACCESS_CODE),
    saludo: `Gracias por llamar a ${n.nombre}. Soy el asistente virtual del restaurante. ¿En qué le puedo ayudar?`
  });
});

app.post('/api/login', auth, (req, res) => res.json({ ok: true }));

app.get('/api/reservas', auth, (req, res) => res.json(leerJSON(F_RESERVAS, [])));
app.get('/api/pedidos', auth, (req, res) => res.json(leerJSON(F_PEDIDOS, [])));
app.post('/api/pedidos/:id/avanzar', auth, (req, res) => {
  const lista = leerJSON(F_PEDIDOS, []);
  const p = lista.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Pedido no encontrado.' });
  const i = ESTADOS.indexOf(p.estado);
  p.estado = ESTADOS[Math.min(i + 1, ESTADOS.length - 1)];
  guardarJSON(F_PEDIDOS, lista);
  res.json(p);
});
app.get('/api/llamadas', auth, (req, res) => res.json(leerJSON(F_LLAMADAS, [])));

app.post('/api/chat', auth, async (req, res) => {
  const mensajes = Array.isArray(req.body.messages) ? req.body.messages : [];
  if (!mensajes.length) return res.status(400).json({ error: 'No hay mensajes.' });
  if (!sumarUso()) return res.status(429).json({ error: 'Se alcanzó el límite diario de mensajes de la demo.' });

  try {
    let texto = await gemini(
      instruccionesAgente(),
      mensajes.map(m => ({ role: m.role === 'model' ? 'model' : 'user', parts: [{ text: String(m.text || '') }] })),
      0.5
    );

    let reserva = null, pedido = null;
    for (const etiqueta of ['RESERVA', 'PEDIDO']) {
      const marca = '[' + etiqueta + ']';
      const e = extraerEtiqueta(texto, etiqueta);
      if (!e) { if (texto.includes(marca)) texto = texto.slice(0, texto.indexOf(marca)).trim(); continue; }
      try {
        const obj = JSON.parse(e.json);
        if (etiqueta === 'RESERVA') {
          reserva = obj; reserva.id = crypto.randomUUID(); reserva.creada = new Date().toISOString();
          const lista = leerJSON(F_RESERVAS, []); lista.push(reserva); guardarJSON(F_RESERVAS, lista);
        } else {
          pedido = armarPedido(obj);
          const lista = leerJSON(F_PEDIDOS, []); lista.push(pedido); guardarJSON(F_PEDIDOS, lista);
        }
      } catch { /* JSON dañado: no se guarda */ }
      texto = (texto.slice(0, e.inicio) + texto.slice(e.fin)).trim();
    }
    res.json({ reply: texto || 'Disculpe, no le entendí bien. ¿Me lo puede repetir?', reserva, pedido });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/llamadas', auth, async (req, res) => {
  const transcript = (Array.isArray(req.body.transcript) ? req.body.transcript : [])
    .map(t => ({ role: t.role === 'model' ? 'model' : 'user', text: String(t.text || '').slice(0, 2000) }));
  const registro = {
    id: crypto.randomUUID(),
    inicio: req.body.inicio || new Date().toISOString(),
    segundos: Math.max(0, Math.round(Number(req.body.segundos) || 0)),
    reservaCreada: Boolean(req.body.reservaCreada),
    pedidoCreado: Boolean(req.body.pedidoCreado),
    transcript,
    resumen: 'Sin conversación.',
    motivo: 'otro',
    resultado: 'resuelta'
  };

  if (transcript.some(t => t.role === 'user') && sumarUso()) {
    try {
      const dialogo = transcript.map(t => (t.role === 'user' ? 'Cliente: ' : 'Agente: ') + t.text).join('\n');
      const salida = await gemini(
        'Analizas llamadas de un restaurante. Responde SOLO un objeto JSON, sin texto adicional ni comillas invertidas, con estas claves: ' +
        '"resumen" (una frase corta en español), ' +
        '"motivo" (una de: reserva, pedido, menu, horario, ubicacion, queja, otro), ' +
        '"resultado" (una de: resuelta, reserva_creada, pedido_creado, requiere_humano).',
        [{ role: 'user', parts: [{ text: dialogo }] }],
        0.2
      );
      const j = JSON.parse(salida.replace(/```json|```/g, '').trim());
      if (j.resumen) registro.resumen = String(j.resumen).slice(0, 300);
      if (j.motivo) registro.motivo = String(j.motivo);
      if (j.resultado) registro.resultado = String(j.resultado);
    } catch {
      registro.resumen = 'Resumen no disponible.';
    }
  }
  if (registro.reservaCreada) registro.resultado = 'reserva_creada';
  if (registro.pedidoCreado) { registro.resultado = 'pedido_creado'; registro.motivo = 'pedido'; }

  const lista = leerJSON(F_LLAMADAS, []);
  lista.push(registro);
  guardarJSON(F_LLAMADAS, lista);
  res.json(registro);
});

app.post('/api/reset', auth, (req, res) => {
  guardarJSON(F_RESERVAS, []);
  guardarJSON(F_LLAMADAS, []);
  guardarJSON(F_PEDIDOS, []);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Agente listo en el puerto ${PORT}.`);
  if (!ACCESS_CODE) console.log('Aviso: ACCESS_CODE está vacío; la app no pide código de acceso.');
});
