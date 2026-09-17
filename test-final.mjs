import WebSocket from 'ws'
const TOKEN = process.argv[2]
const QUESTION = process.argv[3]
const ws = new WebSocket(`ws://127.0.0.1:4000/sessions/new?token=${encodeURIComponent(TOKEN)}`)
const T0 = Date.now()
const timeout = setTimeout(() => { console.log('[test] TIMEOUT'); process.exit(1) }, 700_000)
ws.on('open', () => { setTimeout(() => { ws.send(JSON.stringify({ type: 'followup', text: QUESTION })) }, 1500) })
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  const eventType = msg.event?.type ?? msg.type
  const t = ((Date.now() - T0) / 1000).toFixed(1)
  if (eventType === 'tool/call' || eventType === 'tool/result' || eventType === 'assistant/message') {
    console.log(`[${t}s]`, eventType, JSON.stringify(msg.event ?? msg).slice(0, 3000))
  } else {
    console.log(`[${t}s]`, eventType)
  }
  if (eventType === 'turn/end' || eventType === 'error') {
    clearTimeout(timeout)
    setTimeout(() => process.exit(0), 500)
  }
})
ws.on('error', (e) => console.log('[test] ws error', e.message))
