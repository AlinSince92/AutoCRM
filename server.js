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

// 1. Inicialización de Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const API_KEY = process.env.GROQ_API_KEY;
const API_URL = "https://api.groq.com/openai/v1/chat/completions";

const systemInstruction = `
Eres el asistente virtual inteligente de un concesionario avanzado de compraventa de vehículos.
Tu objetivo es interactuar con clientes que quieren COMPRAR o VENDER un coche.
Tono: Profesional, automotriz, eficiente y resolutivo. Respuestas breves, directas y estructuradas.
Pide siempre de forma natural el nombre, teléfono y qué vehículo buscan o quieren vender para poder contactarles.
`;

// Función para extraer y guardar leads en Supabase de forma inteligente
async function procesarYGuardarLead(history) {
  try {
    const promptExtraccion = [
      ...history,
      {
        role: "user",
        content: `Analiza la conversación anterior. Si el usuario ha facilitado al menos un teléfono o nombre indicando intención de COMPRAR o VENDER un vehículo, extrae los datos en formato JSON estricto.
Si NO hay datos suficientes (por ejemplo, solo ha saludado), responde ÚNICAMENTE con la palabra: NO_LEAD.

Formato JSON esperado (sin bloques de código markdown, solo texto llano JSON):
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
        model: "llama-3.1-8b-instant", // Usamos el modelo ultrarrápido para el parser
        messages: promptExtraccion,
        temperature: 0.1
      })
    });

    const data = await response.json();
    const resultado = data.choices[0].message.content.trim();

    if (resultado !== "NO_LEAD") {
      // Limpiamos posible formato markdown si la IA lo añade por error
      const jsonLimpio = resultado.replace(/```json/g, "").replace(/```/g, "").trim();
      const leadData = JSON.parse(jsonLimpio);

      console.log("🎯 ¡Lead detectado! Guardando en Supabase:", leadData);

      const { data: dbData, error } = await supabase
        .from("leads")
        .insert([leadData]);

      if (error) console.error("❌ Error al guardar en Supabase:", error.message);
      else console.log("✅ Lead guardado exitosamente en la BD");
    }
  } catch (err) {
    console.error("⚠️ Error en el proceso de extracción de lead:", err.message);
  }
}

app.post("/api/chat", async (req, res) => {
  const { history } = req.body;

  if (!history || !Array.isArray(history)) {
    return res.status(400).json({ error: "Historial de chat inválido" });
  }

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
        temperature: 0.7
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || "Error en Groq");
    }

    const reply = data.choices[0].message.content;
    res.json({ reply });

    // Disparamos la extracción en segundo plano para no hacer esperar al usuario
    procesarYGuardarLead([...history, { role: "assistant", content: reply }]);

  } catch (error) {
    console.error("❌ Error API:", error.message);
    res.status(500).json({ error: "Error al procesar la respuesta de la IA" });
  }
});

// Ruta GET para obtener todos los leads guardados en Supabase
app.get("/api/leads", async (req, res) => {
  try {
    const { data: leads, error } = await supabase
      .from("leads")
      .select("*")
      .order("created_at", { ascending: false }); // Los más recientes primero

    if (error) throw error;

    res.json({ leads });
  } catch (error) {
    console.error("❌ Error al obtener leads:", error.message);
    res.status(500).json({ error: "Error al consultar la base de datos" });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚗 Servidor AutoCRM activo en http://localhost:${PORT} 🚗\n`);
});