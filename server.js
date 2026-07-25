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
async function buscarVehiculosEnStock(queryTexto) {
  try {
    // Le pedimos a un modelo ultra rápido que extraiga posibles términos de búsqueda (marca, combustible, etc.)
    const promptFiltros = [
      {
        role: "system",
        content: `Extrae la marca o tipo de vehículo mencionado en el mensaje.
Responde ÚNICAMENTE con la marca o palabra clave en mayúsculas (ej: BMW, AUDI, DIESEL, SEAT).
Si no hay ninguna marca ni filtro claro, responde ÚNICAMENTE: TODOS`
      },
      { role: "user", content: queryTexto }
    ];

    const resFiltros = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: promptFiltros,
        temperature: 0.1
      })
    });

    const dataFiltros = await resFiltros.json();
    const filtro = dataFiltros.choices[0].message.content.trim();

    let query = supabase.from("vehiculos").select("*").eq("estado", "Disponible").limit(5);

    if (filtro !== "TODOS") {
      query = query.or(`marca.ilike.%${filtro}%,modelo.ilike.%${filtro}%,combustible.ilike.%${filtro}%`);
    }

    const { data: vehiculos, error } = await query;
    if (error) throw error;

    return vehiculos || [];
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
  const stockEncontrado = await buscarVehiculosEnStock(ultimoMensaje);
  
  let contextoStock = "";
  if (stockEncontrado.length > 0) {
    contextoStock = `\n[INVENTARIO REAL DISPONIBLE ACTUALMENTE EN EL CONCESIONARIO]:\n` + 
      JSON.stringify(stockEncontrado, null, 2) + 
      `\nUtiliza estos datos precisos para recomendar o confirmar stock al cliente si pregunta por vehículos.`;
  } else {
    contextoStock = `\n[INVENTARIO]: No se han encontrado vehículos exactos para ese filtro en este momento. Ofrece buscar alternativas o tomar sus datos.`;
  }

  const systemInstruction = `
Eres el asistente virtual inteligente de un concesionario avanzado de compraventa de vehículos.
Tu objetivo es interactuar con clientes que quieren COMPRAR o VENDER un coche.
Tono: Profesional, automotriz, eficiente y resolutivo. Respuestas breves, directas y estructuradas.
Pide siempre de forma natural el nombre, teléfono y qué vehículo buscan o quieren vender para poder contactarles.
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