import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Inicialización de Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const API_KEY = process.env.GROQ_API_KEY;
const API_URL = "https://api.groq.com/openai/v1/chat/completions";

// 🔍 Función para consultar vehículos disponibles en Supabase
// 🔍 Función mejorada para consultar vehículos disponibles en Supabase
// 🔍 Función de búsqueda simplificada y 100% compatible con Supabase
// 🔍 Función de búsqueda híbrida: IA + Node.js
async function buscarVehiculosEnStock(queryTexto) {
  try {
    // 1. Usamos la IA ultrarrápida para limpiar el ruido del mensaje del cliente
    const promptFiltros = [
      {
        role: "system",
        content: `Extrae de este mensaje ÚNICAMENTE la marca y modelo del vehículo que el cliente busca. 
Ejemplo 1: "Buenas tardes, quiero un BMW 118i" -> Respuesta: BMW 118i
Ejemplo 2: "¿Tienes algún Audi A4 o similar?" -> Respuesta: Audi A4
Si no menciona ningún coche en concreto (solo saluda o pregunta generalidades), responde ÚNICAMENTE: TODOS`
      },
      { role: "user", content: queryTexto }
    ];

    const resFiltros = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: "llama-3.1-8b-instant", messages: promptFiltros, temperature: 0.1 })
    });

    const dataFiltros = await resFiltros.json();
    const terminoBusqueda = dataFiltros.choices[0].message.content.trim().toLowerCase();

    console.log("🤖 IA extrajo término de búsqueda:", terminoBusqueda);

    // 2. Traemos todos los coches (sin filtrar estado aquí por si hay diferencias de formato en el Excel)
    const { data: todos, error } = await supabase.from("vehiculos").select("*");
    if (error) throw error;
    if (!todos) return [];

    // Si la IA dice TODOS, devolvemos 5 disponibles al azar para tener contexto
    if (terminoBusqueda === "todos" || terminoBusqueda === "") {
      return todos.filter(c => c.estado?.trim().toLowerCase() === "disponible").slice(0, 5);
    }

    // 3. Filtramos estrictamente: el coche debe contener TODAS las palabras clave extraídas (ej: "bmw" Y "118i")
    const palabrasClave = terminoBusqueda.split(" ").filter(p => p.length > 1);
    
    const resultados = todos.filter(coche => {
      // Ignoramos los que no estén disponibles, protegiéndonos de espacios o mayúsculas del Excel
      if (coche.estado && coche.estado.trim().toLowerCase() !== "disponible") return false;
      
      const textoCoche = `${coche.marca} ${coche.modelo}`.toLowerCase();
      
      // .every() asegura que encuentre "bmw" Y "118i", no vale que solo tenga una de las dos
      return palabrasClave.every(palabra => textoCoche.includes(palabra));
    });

    console.log(`🔎 Encontrados ${resultados.length} coches en stock para la búsqueda.`);
    return resultados.slice(0, 5);

  } catch (err) {
    console.error("⚠️ Error consultando stock:", err.message);
    return [];
  }
}

// 🎯 Función para extraer y guardar leads
async function procesarYGuardarLead(history) {
  try {
    const promptExtraccion = [
      ...history,
      {
        role: "user",
        content: `Analiza la conversación anterior. Si el usuario ha facilitado al menos un teléfono o nombre indicando intención de COMPRAR o VENDER un vehículo, extrae los datos en formato JSON estricto.
Si NO hay datos suficientes, responde ÚNICAMENTE: NO_LEAD.

Formato JSON esperado (sin bloques markdown):
{"nombre": "...", "telefono": "...", "operacion": "COMPRA o VENTA", "vehiculo": "...", "detalles": "..."}`
      }
    ];

    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: promptExtraccion,
        temperature: 0.1
      })
    });

    const data = await response.json();
    const resultado = data.choices[0].message.content.trim();

    if (resultado !== "NO_LEAD") {
      const jsonLimpio = resultado.replace(/```json/g, "").replace(/```/g, "").trim();
      const leadData = JSON.parse(jsonLimpio);

      console.log("🎯 Lead detectado. Guardando en Supabase:", leadData);
      await supabase.from("leads").insert([leadData]);
    }
  } catch (err) {
    console.error("⚠️ Error procesando lead:", err.message);
  }
}

// Endpoint principal del Chat
app.post("/api/chat", async (req, res) => {
  const { history } = req.body;

  if (!history || !Array.isArray(history)) {
    return res.status(400).json({ error: "Historial de chat inválido" });
  }

  const ultimoMensaje = history[history.length - 1]?.content || "";

  // 1. Consultamos stock relevante en Supabase
  // 1. Consultamos stock relevante en Supabase
  const stockEncontrado = await buscarVehiculosEnStock(ultimoMensaje);
  
  let contextoStock = "";
  if (stockEncontrado.length > 0) {
    contextoStock = `\n[INVENTARIO REAL DISPONIBLE EN LA BASE DE DATOS]:\n` + 
      JSON.stringify(stockEncontrado, null, 2) + 
      `\nINSTRUCCIÓN CRÍTICA: Usa EXCLUSIVAMENTE los datos de la lista anterior (año, precio, kilómetros, combustible) para responder sobre este coche. Si el usuario pregunta por un dato concreto, da la cifra EXACTA del JSON.`;
  } else {
    contextoStock = `\n[INVENTARIO]: No se ha encontrado ningún vehículo exacto que coincida en la base de datos para esta consulta.
INSTRUCCIÓN CRÍTICA DE SEGURIDAD: NO te inventes el precio, ni el año, ni los kilómetros de ningún coche. Di educadamente que no encuentras ese modelo exacto en el stock actual o pide al cliente su teléfono para que un comercial revise la lista completa de 300 coches.`;
  }

  const systemInstruction = `
Eres el asistente virtual inteligente de un concesionario de compraventa de vehículos.
REGLA DE ORO DE HONESTIDAD: Jamás inventes precios, años o kilómetros de vehículos. Si un coche no aparece en el [INVENTARIO REAL], debes decir que no lo tienes localizado en este momento o consultar con el equipo.
Tono: Profesional, automotriz, eficiente y directo.
Pide de forma natural el nombre y teléfono para poder contactarles.
${contextoStock}
`;

  const messages = [
    { role: "system", content: systemInstruction },
    ...history
  ];

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: messages,
        temperature: 0.6
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || "Error en Groq");
    }

    const reply = data.choices[0].message.content;
    res.json({ reply });

    // Procesar extracción de lead en segundo plano
    procesarYGuardarLead([...history, { role: "assistant", content: reply }]);

  } catch (error) {
    console.error("❌ Error API:", error.message);
    res.status(500).json({ error: "Error al procesar la respuesta de la IA" });
  }
});

// Endpoint para el Dashboard de Leads
app.get("/api/leads", async (req, res) => {
  try {
    const { data: leads, error } = await supabase
      .from("leads")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json({ leads });
  } catch (error) {
    console.error("❌ Error al obtener leads:", error.message);
    res.status(500).json({ error: "Error al consultar la base de datos" });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚗 Servidor AutoCRM activo en puerto ${PORT} 🚗\n`);
});