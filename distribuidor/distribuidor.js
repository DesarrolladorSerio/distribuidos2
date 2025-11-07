// distribuidor/distribuidor.js
const net = require("net");
const http = require("http");
const express = require("express");
const cors = require("cors"); // <- NUEVO
const fs = require("fs");
const path = require("path");

// === CONFIG ===
const PORT_HTTP  = process.env.PORT_HTTP  || 5000; // /aggregate
const PORT_PUMPS = process.env.PORT_PUMPS || 5001; // TCP surtidores
const EMPRESA_HOST = process.env.EMPRESA_HOST || "empresa";
const EMPRESA_PORT = parseInt(process.env.EMPRESA_PORT || "6000", 10);

// === STATE ===
const app = express();
app.use(express.json());
app.use(cors()); // <- HABILITA CORS PARA QUE EL PANEL PUEDA LLAMAR /aggregate

let empresaSock = null;
const surtidores = new Set();
const pumpInfo  = new Map(); // socket -> { id, fuel }
const ventas = []; // {surtidorId, combustible, litros, precio, ts}
const EVENTS_LOG = path.join(__dirname, "events.log");
let preciosActuales = {}; // fuel -> price (se llena con PRICE_SNAPSHOT)

// === HELPERS ===
function sendJSON(sock, obj){ try{ sock.write(JSON.stringify(obj) + "\n"); } catch {} }
function decodeByLine(socket, onMsg){
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
function appendEvent(kind, data){
  try { fs.appendFileSync(EVENTS_LOG, JSON.stringify({ kind, data }) + "\n"); } catch {}
}
function replayBacklogToEmpresa() {
  try {
    if (!fs.existsSync(EVENTS_LOG)) return;
    const lines = fs.readFileSync(EVENTS_LOG, "utf8").trim().split("\n");
    for (const line of lines) {
      if (!line) continue;
      const evt = JSON.parse(line);
      if (evt.kind === "VENTA") {
        const e = evt.data;
        sendJSON(empresaSock, {
          tipo: "EVENT_SYNC",
          id: `venta-${e.cargaN || e.ts}-${e.surtidorId}`,
          event: e,
          ts: Date.now()
        });
      }
    }
  } catch (e) {
    console.error("Error reponiendo backlog:", e.message);
  }
}

// === CONEXIÓN A EMPRESA ===
function conectarEmpresa(){
  empresaSock = new net.Socket();
  empresaSock.setKeepAlive(true);

  empresaSock.connect(EMPRESA_PORT, EMPRESA_HOST, () => {
    console.log("✅ Conectado a Empresa");
    sendJSON(empresaSock, { tipo:"HELLO", id:"DISTRIBUIDOR-1", ts:Date.now() });
    // Pedir snapshot de precios y luego reponer backlog
    sendJSON(empresaSock, { tipo:"GET_PRECIOS", ts: Date.now() });
    replayBacklogToEmpresa();
  });

  decodeByLine(empresaSock, (msg) => {
    if (msg.tipo === "PRICE_SNAPSHOT" && msg.precios) {
      preciosActuales = msg.precios; // cache inicial
    } else if (msg.tipo === "PRECIO_BASE" && msg.tipoCombustible) {
      // Mantener cache al día
      preciosActuales[msg.tipoCombustible] = msg.precio;
      // Fanout SOLO a surtidores del combustible correspondiente
      for (const s of surtidores) {
        const info = pumpInfo.get(s);
        if (info?.fuel === msg.tipoCombustible) {
          sendJSON(s, { tipo:"ACTUALIZAR_PRECIO", fuel:msg.tipoCombustible, precio:msg.precio, ts:Date.now() });
        }
      }
    } else if (msg.tipo === "SYNC_ACK") {
      console.log("SYNC_ACK de Empresa:", msg.id);
    } else if (msg.tipo === "PING") {
      // noop
    } else {
      // otros mensajes
    }
  });

  const retry = (why) => () => {
    console.log("Empresa desconectada:", why);
    try { empresaSock.destroy(); } catch {}
    empresaSock = null;
    setTimeout(conectarEmpresa, 2000);
  };
  empresaSock.on("error", retry("error"));
  empresaSock.on("close", retry("close"));
}
conectarEmpresa();

// === TCP SERVIDOR PARA SURTIDORES ===
const tcpServer = net.createServer((socket) => {
  surtidores.add(socket);
  console.log("⛽ Surtidor conectado");

  decodeByLine(socket, (msg) => {
    if (msg.tipo === "HELLO") {
      pumpInfo.set(socket, { id: msg.surtidorId, fuel: msg.combustible });

      // Al HELLO, empujar precio actual de SU combustible (si lo tenemos)
      const p = preciosActuales[msg.combustible];
      if (typeof p === "number") {
        sendJSON(socket, { tipo:"ACTUALIZAR_PRECIO", fuel: msg.combustible, precio: p, ts: Date.now() });
      }

      if (empresaSock) sendJSON(empresaSock, { tipo:"EVENTO", fuente:"surtidor", evento:"HELLO", data:msg, ts:Date.now() });

    } else if (msg.tipo === "VENTA") {
      // Persistir en memoria y log
      ventas.push({
        surtidorId: msg.surtidorId,
        combustible: msg.combustible,
        litros: msg.litros,
        precio: msg.precio,
        ts: msg.ts || Date.now()
      });
      appendEvent("VENTA", msg);

      // ONLINE: enviamos VENTA en vivo; OFFLINE: queda en log para replay
      if (empresaSock) {
        sendJSON(empresaSock, { tipo:"VENTA", ...msg, ts: Date.now() });
      }

      // ACK al surtidor
      sendJSON(socket, { tipo:"ACK", ackDe:"VENTA", estado:"recibido", ts:Date.now() });

    } else if (msg.tipo === "EVENTO" && msg.evento === "PRECIO_APLICADO_POST_CARGA") {
      if (empresaSock) sendJSON(empresaSock, { tipo:"EVENTO", fuente:"surtidor", data:msg, ts:Date.now() });
    }
  });

  const bye = () => { surtidores.delete(socket); pumpInfo.delete(socket); };
  socket.on("close", bye);
  socket.on("error", bye);
});
tcpServer.listen(PORT_PUMPS, "0.0.0.0", () => console.log("TCP Distribuidor en", PORT_PUMPS));

// === HEARTBEAT JSON HACIA EMPRESA ===
setInterval(() => {
  if (empresaSock) sendJSON(empresaSock, { tipo:"PING", ts:Date.now() });
}, 5000);

// === HTTP REPORTES ===
app.get("/aggregate", (_req, res) => {
  const out = {};
  for (const v of ventas) {
    out[v.combustible] = out[v.combustible] || { litros: 0, total: 0, ventas: 0 };
    out[v.combustible].litros += v.litros;
    out[v.combustible].total  += v.litros * v.precio;
    out[v.combustible].ventas += 1;
  }
  res.json({ ok: true, data: out });
});

http.createServer(app).listen(PORT_HTTP, () => console.log("HTTP Distribuidor en", PORT_HTTP));
