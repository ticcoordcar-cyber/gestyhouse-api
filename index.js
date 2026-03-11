import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors({ origin: ['http://localhost:5174', 'http://localhost:5173', 'http://localhost:3000'] }))
app.use(express.json())
app.use('/fotos', express.static('public/fotos/Nuevas'))

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

// Cache propiedades en memoria (se refresca cada 5 min)
let propiedadesCache = []
let lastFetch = 0

async function getPropiedades() {
  if (Date.now() - lastFetch > 5 * 60 * 1000) {
    const { data } = await supabase
      .from('propiedades')
      .select('referencia, titulo, tipo, estado, operacion, precio, precio_alquiler, metros_construidos, metros_utiles, habitaciones, banos, aseos, garaje, ascensor, terraza, jardin, piscina, trastero, aire_acondicionado, calefaccion, orientacion, certificado_energetico, antiguedad, zona, municipio, descripcion, destacado')
      .order('destacado', { ascending: false })
    propiedadesCache = data || []
    lastFetch = Date.now()
  }
  return propiedadesCache
}

function buildSystemPrompt(propiedades) {
  const formatEuro = (v) => v ? new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(v) : null

  const disponibles = propiedades.filter(p => p.estado === 'disponible')
  const zonas = [...new Set(propiedades.map(p => p.municipio))]
  const precios = disponibles.map(p => p.precio).filter(Boolean)
  const precioMin = precios.length ? Math.min(...precios) : 0
  const precioMax = precios.length ? Math.max(...precios) : 0
  const precioMedio = precios.length ? precios.reduce((a, b) => a + b, 0) / precios.length : 0

  const listadoPropiedades = disponibles.map(p => {
    const detalles = []
    if (p.habitaciones > 0) detalles.push(`${p.habitaciones} hab.`)
    if ((p.banos + p.aseos) > 0) detalles.push(`${p.banos + p.aseos} baños`)
    if (p.metros_construidos) detalles.push(`${p.metros_construidos}m²`)
    if (p.garaje) detalles.push('garaje')
    if (p.piscina) detalles.push('piscina')
    if (p.terraza) detalles.push('terraza')
    if (p.jardin) detalles.push('jardín')

    const precio = p.operacion === 'alquiler'
      ? `${formatEuro(p.precio_alquiler || p.precio)}/mes en alquiler`
      : `${formatEuro(p.precio)} en venta`

    return `• [${p.referencia}] ${p.titulo} — ${p.municipio}${p.zona ? ` (${p.zona})` : ''} — ${precio} — ${p.tipo} — ${detalles.join(', ')}`
  }).join('\n')

  return `Eres GESTIA, la asistente virtual inteligente de GESTYHOUSE, una inmobiliaria líder en la Región de Murcia.

Tu misión es ayudar a los usuarios de forma amable, profesional y en español, respondiendo preguntas sobre:
- Propiedades disponibles (compra y alquiler)
- Precios, características, ubicaciones
- El proceso de compra, venta o alquiler
- Captación de vendedores (si alguien quiere vender su propiedad)

## DATOS DE GESTYHOUSE
- Oficina: Calle Gran Vía, 45, 30004 Murcia
- Teléfono: 968 100 200
- Email: info@gestyhouse.es
- Horario: Lunes-Viernes 9:00-19:00, Sábados 10:00-14:00
- Zonas de actuación: ${zonas.join(', ')}

## ESTADÍSTICAS ACTUALES
- Propiedades disponibles: ${disponibles.length}
- Precio mínimo: ${formatEuro(precioMin)}
- Precio máximo: ${formatEuro(precioMax)}
- Precio medio: ${formatEuro(Math.round(precioMedio))}

## CATÁLOGO COMPLETO DE PROPIEDADES DISPONIBLES
${listadoPropiedades}

## CÓMO DEBES COMPORTARTE
1. Responde siempre en español, de forma cálida y profesional
2. Cuando alguien pregunte por propiedades, filtra del catálogo anterior y presenta las más relevantes de forma clara
3. Si alguien quiere VENDER, recoge: nombre, teléfono, tipo de propiedad, ubicación, precio estimado y estado. Muestra un mensaje de confirmación y diles que un agente les contactará en menos de 24h
4. Si alguien quiere COMPRAR o ALQUILAR, pregunta por su presupuesto, zona preferida y necesidades
5. Si no tienes una propiedad exacta que encaje, ofrece las más similares
6. Sé conciso pero completo. Usa emojis con moderación para hacer la conversación más amena
7. Si te preguntan algo que no tiene que ver con inmobiliaria, redirige amablemente a tu función
8. Nunca inventes datos que no estén en el catálogo
9. Al final de cada respuesta relevante, invita al usuario a contactar con nosotros o visitar la oficina

Recuerda: eres la cara digital de GESTYHOUSE. Cada conversación puede ser una operación inmobiliaria.`
}

// Endpoint: Chat con Claude
app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages requerido' })
    }

    const propiedades = await getPropiedades()
    const systemPrompt = buildSystemPrompt(propiedades)

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content
      }))
    })

    res.json({ content: response.content[0].text })
  } catch (error) {
    console.error('Error Claude API:', error)
    res.status(500).json({ error: 'Error al procesar la consulta' })
  }
})

// Endpoint: Guardar lead (consulta de vendedor/comprador desde el chat)
app.post('/api/leads', async (req, res) => {
  try {
    const { nombre, email, telefono, tipo, mensaje, propiedad_id } = req.body
    const { data, error } = await supabase.from('leads').insert({ nombre, email, telefono, tipo, mensaje, propiedad_id })
    if (error) throw error
    res.json({ success: true, data })
  } catch (error) {
    console.error('Error lead:', error)
    res.status(500).json({ error: 'Error al guardar la consulta' })
  }
})

// Endpoint: Propiedades destacadas para la web
app.get('/api/propiedades', async (req, res) => {
  try {
    const { tipo, estado, municipio, operacion, min_precio, max_precio, habitaciones } = req.query
    let q = supabase
      .from('propiedades')
      .select('*, fotos_propiedades(url, es_principal, orden)')
      .order('destacado', { ascending: false })
      .order('created_at', { ascending: false })

    if (estado) q = q.eq('estado', estado)
    else q = q.eq('estado', 'disponible')
    if (tipo) q = q.eq('tipo', tipo)
    if (municipio) q = q.eq('municipio', municipio)
    if (operacion) q = q.eq('operacion', operacion)
    if (min_precio) q = q.gte('precio', min_precio)
    if (max_precio) q = q.lte('precio', max_precio)
    if (habitaciones) q = q.gte('habitaciones', habitaciones)

    const { data, error } = await q
    if (error) throw error

    const result = (data || []).map(p => ({
      ...p,
      fotos_propiedades: p.fotos_propiedades?.sort((a, b) => a.orden - b.orden)
    }))

    res.json(result)
  } catch (error) {
    console.error('Error propiedades:', error)
    res.status(500).json({ error: 'Error al obtener propiedades' })
  }
})

// Endpoint: Propiedad individual
app.get('/api/propiedades/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('propiedades')
      .select('*, fotos_propiedades(*), agentes(*)')
      .eq('id', req.params.id)
      .single()
    if (error) throw error
    res.json({ ...data, fotos_propiedades: data.fotos_propiedades?.sort((a, b) => a.orden - b.orden) })
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener la propiedad' })
  }
})

app.listen(PORT, () => {
  console.log(`\n🏠 GESTYHOUSE API Server corriendo en http://localhost:${PORT}`)
  console.log(`   - Chat IA:    POST /api/chat`)
  console.log(`   - Propiedades: GET /api/propiedades`)
  console.log(`   - Leads:      POST /api/leads\n`)
})
