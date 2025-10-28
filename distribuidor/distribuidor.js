const net = require("net");
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const path = require("path");

const PORT_HTTP = process.env.PORT_HTTP || 5000;
const PORT_SURTIDORES = process.env.PORT_SURTIDORES || 5001;
const EMPRESA_HOST = process.env.EMPRESA_HOST || "empresa";
const EMPRESA_PORT = process.env.EMPRESA_PORT || 6000;
const FACTOR_UTILIDAD = parseFloat(process.env.FACTOR_UTILIDAD || "1.05");

const app = express();
app.use(express.json());

// --- Base de datos local + redundancia ---
const dbFile = path.join(__dirname, "ventas.db");
const db = new sqlite3.Database(dbFile);
const eventsLog = path.join(__dirname, "events.log");

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS ventas(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER,
    surtidorId TEXT,
    tipo TEXT,
    litros REAL
  )`);
});

function appendEvent(event) {
  try {
    fs.appendFileSync(eventsLog, JSON.stringify(event) + "\n");
  } catch (e) {
    console.error("Error al escribir en log de eventos:", e.message);
  }
}

// --- Servidor TCP para surtidores ---
let surtidores = [];
const serverSurtidores = net.createServer((socket) => {
  surtidores.push(socket);
  console.log("⛽ Surtidor conectado");

  socket.on("data", (data) => {
    try {
      const info = JSON.parse(data.toString());
      if (info.tipo === "VENTA") {
        db.run(
          "INSERT INTO ventas(ts,surtidorId,tipo,litros) VALUES(?,?,?,?)",
          [info.ts || Date.now(), info.surtidorId || "S?", info.combustible, info.litros]
        );
        appendEvent({ kind: "VENTA", ...info });
        console.log("💾 Venta registrada:", info);
      }
    } catch (e) {
      console.error("Error parseando data de surtidor:", e.message);
    }
  });

  socket.on("end", () => {
    surtidores = surtidores.filter((s) => s !== socket);
  });
});
serverSurtidores.listen(PORT_SURTIDORES, "0.0.0.0", () =>
  console.log(`Servidor TCP Surtidores en ${PORT_SURTIDORES}`)
);

// --- Cliente TCP hacia la empresa ---
const clientEmpresa = new net.Socket();
let conectado = false;

// Reconexión automática
function conectarEmpresa() {
  if (conectado) return;
  console.log("🔄 Intentando conectar con la empresa...");
  clientEmpresa.connect(EMPRESA_PORT, EMPRESA_HOST, () => {
    conectado = true;
    console.log("✅ Conectado con la empresa");
    enviarPendientes();
  });
}

clientEmpresa.on("error", () => {
  if (conectado) console.log("⚠️ Conexión perdida con la empresa");
  conectado = false;
  setTimeout(conectarEmpresa, 10000);
});

clientEmpresa.on("close", () => {
  conectado = false;
  console.log("🔌 Desconectado de la empresa, operando localmente");
  setTimeout(conectarEmpresa, 10000);
});

clientEmpresa.on("data", (data) => {
  try {
    const msg = JSON.parse(data.toString());
    if (msg.tipo === "PRECIO_BASE") {
      const nuevoPrecio = msg.precio * FACTOR_UTILIDAD;
      console.log("📢 Nuevo precio (con utilidad):", nuevoPrecio);
      const payload = JSON.stringify({
        tipo: "ACTUALIZAR_PRECIO",
        precio: nuevoPrecio,
        ts: Date.now(),
      });
      surtidores.forEach((s) => {
        try {
          s.write(payload);
        } catch {}
      });
    } else if (msg.tipo === "SYNC_ACK") {
      console.log("📬 Sincronización confirmada por empresa");
    }
  } catch (e) {
    console.error("Error parseando mensaje desde empresa:", e.message);
  }
});

// Reenvío periódico de heartbeat
setInterval(() => {
  if (conectado) clientEmpresa.write("PING DISTRIBUIDOR");
}, 15000);

conectarEmpresa();

// --- Sincronización de eventos pendientes ---
function enviarPendientes() {
  if (!fs.existsSync(eventsLog)) return;
  const lines = fs.readFileSync(eventsLog, "utf8").split("\n").filter(Boolean);
  if (lines.length === 0) return;

  console.log(`📤 Enviando ${lines.length} eventos pendientes a la empresa...`);
  lines.forEach((line) => {
    try {
      const ev = JSON.parse(line);
      const payload = JSON.stringify({ tipo: "EVENT_SYNC", evento: ev });
      clientEmpresa.write(payload);
    } catch (e) {
      console.error("Error enviando evento:", e.message);
    }
  });

  // Limpia el log después de sincronizar
  fs.writeFileSync(eventsLog, "");
}

// --- HTTP API para reportes ---
app.get("/aggregate", (req, res) => {
  db.all(
    `SELECT tipo, COUNT(*) as cargas, SUM(litros) as litros
     FROM ventas GROUP BY tipo`,
    (err, rows) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true, data: rows || [] });
    }
  );
});

// --- Snapshot de redundancia ---
app.post("/snapshot", (req, res) => {
  try {
    const backup = path.join(__dirname, "ventas.db.bak");
    fs.copyFileSync(dbFile, backup);
    res.json({ ok: true, backup });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT_HTTP, () =>
  console.log(`HTTP Distribuidor en puerto ${PORT_HTTP}`)
);
