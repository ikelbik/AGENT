// ─── Gemma / LM Studio client (OpenAI-compatible) ────────────────────────────
// Drop-in замена Anthropic SDK для бэкенда.
// Переменная среды GEMMA_URL задаёт базовый URL (ngrok или локальный).

import 'dotenv/config'

const BASE_URL  = process.env.GEMMA_URL || 'https://supply-smock-trillion.ngrok-free.dev'
const CHAT_URL  = BASE_URL + '/v1/chat/completions'
const MODELS_URL = BASE_URL + '/v1/models'

const HEADERS = {
  'Content-Type': 'application/json',
  'ngrok-skip-browser-warning': '1',
  'Accept': 'application/json'
}

// Кешируем имя модели чтобы не дёргать /v1/models на каждый запрос
let _cachedModel = null

async function resolveModel() {
  if (_cachedModel) return _cachedModel
  try {
    const res = await fetch(MODELS_URL, { method: 'GET', headers: HEADERS })
    if (res.ok) {
      const data = await res.json()
      if (data.data?.length) {
        _cachedModel = data.data[0].id
        console.log(`[gemma] model: ${_cachedModel}`)
        return _cachedModel
      }
    }
  } catch (e) {
    console.warn('[gemma] cannot fetch models:', e.message)
  }
  return 'local-model'
}

// ─── Основная функция вызова ──────────────────────────────────────────────────
// Принимает те же параметры что Anthropic SDK (system, messages, max_tokens)
// Возвращает { content: [{ text: '...' }] } — совместимо с кодом под Anthropic

export async function complete({ system, messages, max_tokens = 1200 }) {
  const model = await resolveModel()

  // Собираем сообщения в OpenAI-формат
  const openaiMessages = []
  if (system) openaiMessages.push({ role: 'system', content: system })
  openaiMessages.push(...messages)

  const response = await fetch(CHAT_URL, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      model,
      messages: openaiMessages,
      temperature: 0.7,
      max_tokens,
      stream: false
    })
  })

  if (!response.ok) {
    const err = await response.text().catch(() => response.statusText)
    throw new Error(`Gemma API ${response.status}: ${err.substring(0, 200)}`)
  }

  const data = await response.json()
  const text = data.choices?.[0]?.message?.content ?? ''

  return { content: [{ text }] }
}

// ─── Anthropic-совместимый объект-клиент ──────────────────────────────────────
// Позволяет заменить `new Anthropic()` на `gemma` без правки остального кода

export const gemma = {
  messages: {
    create: (opts) => complete(opts)
  }
}
