// surtidor/surtidor.js
const net = require("net");

const DISTRIBUIDOR_HOST = process.env.DISTRIBUIDOR_HOST || "distribuidor";
const DISTRIBUIDOR_PORT = parseInt(process.env.DISTRIBUIDOR_PORT || "5001", 10);
const SURTIDOR_ID = process.env.SURTIDOR_ID || "S1";
const TIPO_COMBUSTIBLE = process.env.TIPO_COMBUSTIBLE || "93";

let precio = 1300;
let enUso = false;
let cargas = 0;
let pendientePrecio = null;

let client = null;
let inputBuffer = "";
let reconnectDelay = 1000;

function send(obj) { if (!client) return; try { client.write(JSON.stringify(obj) + "\n"); } catch {} }

function conectar() {
  client = new net.Socket();
  client.setKeepAlive(true);
  client.connect(DISTRIBUIDOR_PORT, DISTRIBUIDOR_HOST, () => {
    console.log(`Conectado @ ${DISTRIBUIDOR_HOST}:${DISTRIBUIDOR_PORT}`);
    reconnectDelay = 1000;
    send({ tipo: "HELLO", surtidorId: SURTIDOR_ID, combustible: TIPO_COMBUSTIBLE, ts: Date.now() });
  });

  client.on("data", (chunk) => {
    inputBuffer += chunk.toString();
    let idx;
    while ((idx = inputBuffer.indexOf("\n")) >= 0) {
      const line = inputBuffer.slice(0, idx);
      inputBuffer = inputBuffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.tipo === "ACTUALIZAR_PRECIO") {
          if (enUso) {
            pendientePrecio = msg.precio;
            send({ tipo: "ACK", ackDe: "ACTUALIZAR_PRECIO", surtidorId: SURTIDOR_ID, estado: "pendiente", ts: Date.now() });
          } else {
            precio = msg.precio;
            send({ tipo: "ACK", ackDe: "ACTUALIZAR_PRECIO", surtidorId: SURTIDOR_ID, estado: "aplicado", precio, ts: Date.now() });
            console.log(`💲 ${SURTIDOR_ID} nuevo precio aplicado: ${precio}`);
          }
        }
      } catch {}
    }
  });

  const onClose = (why) => () => {
    console.log(`[${SURTIDOR_ID}] desconectado (${why}). Reintentando en ${reconnectDelay}ms`);
    try { client.destroy(); } catch {}
    client = null;
    setTimeout(conectar, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  };
  client.on("error", onClose("error"));
  client.on("close", onClose("close"));
}
conectar();

function simularVenta() {
  if (enUso || !client) return;
  enUso = true;
  const litros = 5 + Math.floor(Math.random() * 10);
  cargas++;
  const cargaN = cargas;
  console.log(`⛽ ${SURTIDOR_ID} ${litros}L ${TIPO_COMBUSTIBLE} a $${precio} (carga ${cargaN})`);

  send({ tipo: "VENTA", surtidorId: SURTIDOR_ID, combustible: TIPO_COMBUSTIBLE, litros, precio, cargaN, ts: Date.now() });

  setTimeout(() => {
    enUso = false;
    if (pendientePrecio != null) {
      precio = pendientePrecio;
      pendientePrecio = null;
      send({ tipo: "EVENTO", evento: "PRECIO_APLICADO_POST_CARGA", surtidorId: SURTIDOR_ID, precio, ts: Date.now() });
      console.log(`💲 ${SURTIDOR_ID} precio pendiente aplicado tras venta: ${precio}`);
    }
  }, 3000);
}

setInterval(simularVenta, 5000);
