#!/usr/bin/env node
// Spike (docs/single-backend-architecture-plan.md, giai đoạn 0): a deterministic
// OpenAI-compatible `/chat/completions` SSE server standing in for the real LLM.
//
// - Records every request body, so a test can assert which `tools` and which
//   system prompt each session was given (GET /_requests, DELETE /_requests).
// - Scripted tool calls: when the LAST user message contains `CALL <tool> <json>`
//   the reply is that single tool call. After a tool result, the reply is
//   `DONE: <first 400 chars of the tool result>` so a test can read what the tool
//   returned. Anything else gets `OK`.
//
//   node scripts/mock-llm.mjs [port]      (default 4999)

import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? process.env.MOCK_LLM_PORT ?? 4999)
const requests = []

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
  return ''
}

// The runtime also appends plugin-sourced user messages (`<system-reminder>`: skill catalog, ...);
// the human's message is the last user message that is not one of those.
function humanUser(messages) {
  return [...(messages ?? [])].reverse().find((m) => m.role === 'user' && !textOf(m.content).startsWith('<system-reminder>'))
}

function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

function reply(body) {
  const messages = body.messages ?? []
  const last = messages[messages.length - 1]
  const base = { id: 'mock', object: 'chat.completion.chunk', created: 0, model: body.model ?? 'mock' }
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }

  if (last?.role === 'tool') {
    const text = `DONE: ${textOf(last.content).slice(0, 400)}`
    return [
      { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { ...base, choices: [], usage },
    ]
  }

  const user = humanUser(messages)
  const match = /CALL (\S+) (\{.*\})/s.exec(textOf(user?.content))
  if (match) {
    return [
      {
        ...base,
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{ index: 0, id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name: match[1], arguments: match[2] } }],
          },
          finish_reason: null,
        }],
      },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { ...base, choices: [], usage },
    ]
  }

  // A long reply streamed in pieces (lets a test cut the connection mid-stream).
  const pieces = (/SLOW/.test(textOf(user?.content)) ? 40 : 1)
  const chunks = [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }]
  for (let i = 0; i < pieces; i += 1) {
    chunks.push({ ...base, choices: [{ index: 0, delta: { content: pieces === 1 ? 'OK' : `piece-${i} ` }, finish_reason: null }] })
  }
  chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, { ...base, choices: [], usage })
  return chunks
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/_requests') {
    if (req.method === 'DELETE') requests.length = 0
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(requests))
    return
  }
  if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const body = JSON.parse(raw)
      requests.push({
        at: Date.now(),
        model: body.model,
        system: textOf(body.messages?.find((m) => m.role === 'system')?.content),
        tools: (body.tools ?? []).map((t) => t.function?.name),
        // names in the skill catalog the runtime appends as a plugin-sourced user message
        skills: [...(body.messages ?? [])]
          .filter((m) => m.role === 'user' && textOf(m.content).includes('<available_skills>'))
          .flatMap((m) => [...textOf(m.content).matchAll(/^- `([^`]+)`/gm)].map((x) => x[1])),
        lastUser: textOf(humanUser(body.messages)?.content).slice(0, 200),
      })
      const chunks = reply(body)
      const slow = chunks.length > 6
      if (!slow) return sse(res, chunks)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      let i = 0
      const timer = setInterval(() => {
        if (i >= chunks.length) {
          clearInterval(timer)
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        res.write(`data: ${JSON.stringify(chunks[i])}\n\n`)
        i += 1
      }, 50)
      res.on('close', () => clearInterval(timer))
    })
    return
  }
  res.writeHead(404)
  res.end()
}).listen(port, process.env.MOCK_BIND ?? '127.0.0.1', () => console.log(`[mock-llm] http://${process.env.MOCK_BIND ?? '127.0.0.1'}:${port}`))
