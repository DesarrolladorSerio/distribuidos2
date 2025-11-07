// empresa/empresa.js
const net = require("net");
const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT_HTTP = process.env.PORT_HTTP || 8080; // Panel/REST
const PORT_TCP  = process.env.PORT_TCP  || 6000; // TCP con distribuidores
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, "config.json");

const app = express();
app.use(express.json());
app.use(express.static("public"));

// --- Config persistente ---
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { return { distribuidoresRegistrados: [] }; }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
let config = loadConfig();

// Precios base por combustible (ajusta si quieres cargarlos de config)
let preciosBase = { "93": 1000, "95": 1250, "97": 1300, "diesel": 1100, "kerosene": 900 };

// Conexiones TCP de distribuidores
let distribuidores = new Set();
const distributorMeta = new Map(); // socket -> { id, helloTs, addr }

// Helpers NDJSON
function sendJSON(sock, obj) { try { sock.write(JSON.stringify(obj) + "\n"); } catch {} }
function decodeByLine(socket, onMsg) {
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try { onMsg(JSON.parse(line)); } catch {}
    }
  });
}

// ---- Servidor TCP (empresa <= distribuidores) ----
const tcpServer = net.createServer((socket) => {
  const remoteId = `${socket.remoteAddress}:${socket.remotePort}`;
  distribuidores.add(socket);
  distributorMeta.set(socket, { id: remoteId, helloTs: Date.now(), addr: remoteId });

  console.log("📡 Distribuidor conectado:", remoteId);
  broadcast(`📡 Distribuidor conectado: ${remoteId}`);

  decodeByLine(socket, (msg) => {
    // Ocultar PING en el panel
    if (msg.tipo === "PING") return;

    // 1) Identificación del distribuidor
    if (msg.tipo === "HELLO" && msg.id) {
      const meta = distributorMeta.get(socket) || {};
      meta.id = msg.id;
      meta.helloTs = Date.now();
      distributorMeta.set(socket, meta);
      broadcast(`🤝 HELLO de distribuidor ${meta.id}`);
      return;
    }

    // 2) Distribuidor pide snapshot de precios
    if (msg.tipo === "GET_PRECIOS") {
      sendJSON(socket, { tipo: "PRICE_SNAPSHOT", precios: preciosBase, ts: Date.now() });
      broadcast(`📦 Snapshot de precios enviado a ${distributorMeta.get(socket)?.id || remoteId}`);
      return;
    }

    // 3) Re-sincronización (EVENT_SYNC -> SYNC_ACK)
    if (msg.tipo === "EVENT_SYNC") {
      sendJSON(socket, { tipo: "SYNC_ACK", id: msg.id || null, ts: Date.now() });
      broadcast(`🔁 Re-sync recibido: ${JSON.stringify(msg.event).slice(0, 160)}...`);
      return;
    }

    // 4) Venta en vivo (cuando el distribuidor está online)
    if (msg.tipo === "VENTA") {
      broadcast(`🧾 Venta recibida: ${JSON.stringify(msg).slice(0, 160)}...`);
      return;
    }

    // 5) Otros eventos
    broadcast(`📥 Mensaje desde distribuidor: ${JSON.stringify(msg).slice(0, 160)}...`);
  });

  const cleanup = (why) => () => {
    const id = distributorMeta.get(socket)?.id || remoteId;
    broadcast(`⚠️ Distribuidor desconectado (${why}): ${id}`);
    distribuidores.delete(socket);
    distributorMeta.delete(socket);
    try { socket.destroy(); } catch {}
  };
  socket.on("end", cleanup("end"));
  socket.on("error", cleanup("error"));
  socket.on("close", cleanup("close"));
});

tcpServer.listen(PORT_TCP, "0.0.0.0", () => {
  console.log(`TCP Empresa escuchando en ${PORT_TCP}`);
});

// ---- HTTP + WebSocket ----
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer });

let socketsWS = [];
wss.on("connection", (ws) => {
  socketsWS.push(ws);
  ws.send("🔌 Conectado al panel en vivo");
  ws.on("close", () => { socketsWS = socketsWS.filter((s) => s !== ws); });
});
function broadcast(msg) {
  socketsWS.forEach((ws) => { try { ws.send(msg); } catch {} });
}

// --- API Empresa ---
app.get("/health", (_req, res) => res.json({ ok: true, role: "empresa", now: Date.now() }));
app.get("/precios", (_req, res) => res.json(preciosBase));

// actualizar precio
app.post("/actualizar", (req, res) => {
  const { tipo, nuevoPrecio } = req.body || {};
  if (!tipo || typeof nuevoPrecio !== "number") {
    return res.status(400).json({ ok: false, error: "tipo y nuevoPrecio requeridos" });
  }
  preciosBase[tipo] = nuevoPrecio;
  broadcast(`✅ Precio actualizado: ${tipo} -> ${nuevoPrecio}`);

  const payload = { tipo: "PRECIO_BASE", tipoCombustible: tipo, precio: nuevoPrecio, ts: Date.now() };
  for (const sock of distribuidores) sendJSON(sock, payload);

  res.json({ ok: true });
});

// Config (persistente desde UI) — admite arrays de string o de objetos {name,host,port}
app.get("/config", (_req, res) => res.json(config));

app.post("/config", (req, res) => {
  const body = req.body || {};
  let list = body.distribuidoresRegistrados;

  if (!Array.isArray(list)) {
    return res.status(400).json({ ok: false, error: "distribuidoresRegistrados debe ser un arreglo" });
  }

  // Normalizar: aceptar ["http://host:5000", ...] o [{name,host,port}, ...]
  const normalized = [];
  for (const item of list) {
    if (typeof item === "string") {
      // intentar parsear una URL
      try {
        const u = new URL(item);
        normalized.push({ name: u.hostname, host: `${u.protocol}//${u.hostname}`, port: Number(u.port || 80) });
      } catch {
        // string simple (sin protocolo/puerto): asumir host, puerto 5000
        normalized.push({ name: item, host: `http://${item}`, port: 5000 });
      }
    } else if (item && typeof item === "object") {
      const name = String(item.name || item.host || "").trim();
      let host = String(item.host || "").trim();
      const port = Number(item.port || 5000);
      if (!host) continue;
      if (!/^https?:\/\//i.test(host)) host = "http://" + host;
      normalized.push({ name: name || (new URL(host)).hostname, host, port });
    }
  }

  config.distribuidoresRegistrados = normalized;
  saveConfig(config);
  res.json({ ok: true, data: normalized });
});

// Distribuidores conectados (runtime)
app.get("/distribuidores", (_req, res) => {
  const list = [];
  for (const sock of distribuidores) {
    const meta = distributorMeta.get(sock) || {};
    list.push({
      id: meta.id || meta.addr,
      helloTs: meta.helloTs || null,
      address: meta.addr || null
    });
  }
  res.json({ ok: true, data: list });
});

// Reportes (nota)
app.get("/reportes", (_req, res) => {
  res.json({ ok: true, nota: "Usa la configuración para registrar distribuidores {name,host,port} y el panel consultará /aggregate." });
});

httpServer.listen(PORT_HTTP, () => {
  console.log(`HTTP Empresa en http://localhost:${PORT_HTTP}`);
});
