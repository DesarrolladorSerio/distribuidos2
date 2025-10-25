const net = require("net");
const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT_HTTP = process.env.PORT_HTTP || 8080;
const PORT_TCP = process.env.PORT_TCP || 6000;
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, "config.json");

const app = express();
app.use(express.json());
app.use(express.static("public"));

// Carga/guarda configuración (distribuidores registrados, etc.)
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { return { distribuidoresRegistrados: [] }; }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
let config = loadConfig();

// Precios base por combustible
let preciosBase = { "93": 1200, "95": 1250, "97": 1300, "diesel": 1100, "kerosene": 900 };

// Sockets TCP de distribuidores conectados
let distribuidores = [];
let socketsWS = [];

// ---- Servidor TCP para distribuidores ----
const tcpServer = net.createServer((socket) => {
  const remoteId = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log("📡 Distribuidor conectado:", remoteId);
  distribuidores.push(socket);
  broadcast(`📡 Distribuidor conectado: ${remoteId}`);

  socket.on("data", (data) => {
    try {
      const msg = data.toString();
      broadcast(`📥 Mensaje desde distribuidor: ${msg}`);
    } catch (e) {
      broadcast(`⚠️ Error parseando mensaje TCP: ${e.message}`);
    }
  });

  socket.on("end", () => {
    broadcast(`⚠️ Distribuidor desconectado: ${remoteId}`);
    distribuidores = distribuidores.filter(s => s !== socket);
  });

  socket.on("error", (err) => {
    broadcast(`⚠️ Error socket distribuidor ${remoteId}: ${err.message}`);
  });
});
tcpServer.listen(PORT_TCP, "0.0.0.0", () => console.log(`Servidor TCP (puerto ${PORT_TCP})`));

// ---- HTTP + WebSocket ----
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  socketsWS.push(ws);
  ws.send("🔌 Conectado al panel en vivo");
  ws.on("close", () => socketsWS = socketsWS.filter(s => s !== ws));
});

function broadcast(msg) {
  socketsWS.forEach((ws) => { try { ws.send(msg); } catch {} });
}

// API precios
app.get("/precios", (req, res) => res.json(preciosBase));

app.post("/actualizar", (req, res) => {
  const { tipo, nuevoPrecio } = req.body || {};
  if (!tipo || typeof nuevoPrecio !== "number") {
    return res.status(400).json({ ok: false, error: "tipo y nuevoPrecio requeridos" });
  }
  preciosBase[tipo] = nuevoPrecio;
  broadcast(`💸 Nuevo precio ${tipo}: ${nuevoPrecio}`);
  // Propagar a distribuidores conectados
  const payload = JSON.stringify({ tipo: "PRECIO_BASE", tipoCombustible: tipo, precio: nuevoPrecio, ts: Date.now() });
  distribuidores.forEach((sock) => { try { sock.write(payload); } catch {} });
  res.json({ ok: true });
});

// Configuración de distribuidores (GUI)
app.get("/config", (req, res) => res.json(config));
app.post("/config", (req, res) => {
  const { distribuidoresRegistrados } = req.body || {};
  if (!Array.isArray(distribuidoresRegistrados)) return res.status(400).json({ ok: false, error: "formato inválido" });
  config.distribuidoresRegistrados = distribuidoresRegistrados;
  saveConfig(config);
  res.json({ ok: true });
});

// Reportes (stub: en una versión extendida, la empresa consolidaría de múltiples distribuidores)
app.get("/reportes", (req, res) => {
  // Este endpoint podría consultar a los distribuidores vía HTTP si expusieran /aggregate
  res.json({ ok: true, nota: "En esta versión, los agregados viven en el distribuidor (/aggregate)" });
});

async function actualizarReportes() {
  const resCfg = await fetch("/config");
  const cfg = await resCfg.json();
  const repDiv = document.getElementById("reportes");
  repDiv.innerHTML = "<i>Consultando distribuidores...</i>";

  let html = "";
  for (const dist of cfg.distribuidoresRegistrados || []) {
    try {
      const url = `http://${dist.host}:${dist.puerto}/aggregate`;
      const res = await fetch(url);
      const data = await res.json();
      html += `<h4>Distribuidor ${dist.id}</h4>`;
      html += "<table border='1' cellpadding='4'><tr><th>Combustible</th><th>Cargas</th><th>Litros</th></tr>";
      (data.data || []).forEach(r => {
        html += `<tr><td>${r.tipo}</td><td>${r.cargas}</td><td>${r.litros.toFixed(2)}</td></tr>`;
      });
      html += "</table>";
    } catch (e) {
      html += `<p style='color:red;'>❌ No se pudo conectar a ${dist.id} (${dist.host}:${dist.puerto})</p>`;
    }
  }
  repDiv.innerHTML = html;
}


httpServer.listen(PORT_HTTP, () => console.log(`Panel Web + API disponible en http://localhost:${PORT_HTTP}`));


