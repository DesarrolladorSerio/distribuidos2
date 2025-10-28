const net = require("net");

const DISTRIBUIDOR_HOST = process.env.DISTRIBUIDOR_HOST || "distribuidor";
const DISTRIBUIDOR_PORT = parseInt(process.env.DISTRIBUIDOR_PORT || "5001", 10);
const SURTIDOR_ID = process.env.SURTIDOR_ID || "S1";
const TIPO_COMBUSTIBLE = process.env.TIPO_COMBUSTIBLE || "93";

let precio = 1300;
let enUso = false;
let cargas = 0;

const client = new net.Socket();
client.connect(DISTRIBUIDOR_PORT, DISTRIBUIDOR_HOST, () => console.log(`Conectado al distribuidor @ ${DISTRIBUIDOR_HOST}:${DISTRIBUIDOR_PORT}`));

function simularVenta() {
  if (enUso) return;
  enUso = true;
  const litros = 5 + Math.floor(Math.random() * 10);
  cargas++;
  console.log(`⛽ ${SURTIDOR_ID} vendiendo ${litros}L de ${TIPO_COMBUSTIBLE} a $${precio}`);
  const payload = { tipo: "VENTA", surtidorId: SURTIDOR_ID, combustible: TIPO_COMBUSTIBLE, litros, cargaN: cargas, ts: Date.now() };
  try { client.write(JSON.stringify(payload)); } catch {}
  setTimeout(() => { enUso = false; }, 3000);
}

client.on("data", (data) => {
  try {
    const msg = JSON.parse(data.toString());
    if (msg.tipo === "ACTUALIZAR_PRECIO" && !enUso) {
      precio = msg.precio;
      console.log(`💲 ${SURTIDOR_ID} nuevo precio recibido: ${precio}`);
    }
  } catch {}
});

setInterval(simularVenta, 5000);
