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
async function buscarVehiculosEnStock(queryTexto) {
  try {
    // 1. Extraemos palabras de más de 1 letra y limpiamos signos
    const palabras = queryTexto
      .replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, "")
      .split(/\s+/)
      .filter(p => p.length > 1);

    if (palabras.length === 0) {
      const { data } = await supabase.from("vehiculos").select("*").eq("estado", "Disponible").limit(5);
      return data || [];
    }

    // 2. Traemos los vehículos disponibles y filtramos en Node.js para evitar errores de sintaxis en PostgREST
    const { data: todosLosVehiculos, error } = await supabase
      .from("vehiculos")
      .select("*")
      .eq("estado", "Disponible");

    if (error) throw error;
    if (!todosLosVehiculos) return [];

    // 3. Buscamos coincidencias de las palabras del usuario dentro de los campos del coche
    const resultados = todosLosVehiculos.filter(coche => {
      const textoCoche = `${coche.marca} ${coche.modelo} ${coche.combustible} ${coche.transmision}`.toLowerCase();
      // Retorna true si al menos una palabra del mensaje del cliente está en los datos del coche
      return palabras.some(palabra => textoCoche.includes(palabra.toLowerCase()));
    });

    console.log(`🔎 Búsqueda de stock para "${queryTexto}": Encontrados ${resultados.length} coches.`);
    return resultados.slice(0, 5); // Devolvemos los 5 mejores resultados

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