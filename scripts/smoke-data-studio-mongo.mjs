#!/usr/bin/env node
// Smoke test for Data Studio's MongoDB layer as gateway uses it (docs/data-studio-mongodb-plan.md).
// Exercises every function of services/gateway/src/data-studio-db.ts against a REAL MongoDB, in a
// throw-away database that is dropped at the end — it never touches MONGODB_DATABASE_NAME.
//
//   docker compose -f infra/docker/docker-compose.dev.yml up -d mongo
//   node --experimental-strip-types scripts/smoke-data-studio-mongo.mjs
//
// MONGODB_URL defaults to mongodb://127.0.0.1:27017. Requires Node >= 22 (see .nvmrc).

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const url = process.env.MONGODB_URL ?? 'mongodb://127.0.0.1:27017'
const testDb = `fox_ds_smoke_${randomUUID().slice(0, 8)}`

// gateway/src/config.ts fails loud on these at import time; the smoke test never uses them.
process.env.MONGODB_URL = url
process.env.MONGODB_DATABASE_NAME = testDb
process.env.S3_BUCKET ??= 'smoke'
process.env.S3_ACCESS_KEY_ID ??= 'smoke'
process.env.S3_SECRET_ACCESS_KEY ??= 'smoke'

const { checkMongoConnection, ensureIndexes, col, getDb, closeMongo } = await import('../services/gateway/src/mongo.ts')
const ds = await import('../services/gateway/src/data-studio-db.ts')

let step = 0
const ok = (message) => console.log(`  ok ${++step}. ${message}`)

try {
  assert.equal(await checkMongoConnection(), true, `cannot reach MongoDB at ${url.replace(/\/\/[^@]*@/, '//***@')}`)
  await ensureIndexes()
  ok(`connected, indexes ensured (database ${testDb})`)
  await ensureIndexes()
  ok('ensureIndexes is idempotent')

  // Seed the way the Python sync writes (crud_mongo): values-not-names enums, native arrays/bools.
  const at = new Date()
  const source = { _id: randomUUID(), name: 'src', source_type: 'mysql', dremio_path: 'src', status: 'connected', last_synced_at: at, is_exposed_to_agent: true, created_at: at, updated_at: at }
  const entity = (name) => ({ _id: randomUUID(), data_source_id: source._id, physical_path: `src.db.${name}`, physical_name: name, entity_type: 'table', last_synced_at: at, is_deprecated: false, display_name: name, description: null, synonyms: [], grain_description: null, is_exposed: true, is_pii: false, row_count_est: null, last_profiled_at: null, embed_text: null, created_at: at, updated_at: at })
  const orders = entity('orders')
  const customers = entity('customers')
  const column = (e, name, ordinal) => ({ _id: randomUUID(), entity_id: e._id, physical_name: name, data_type: 'INTEGER', ordinal, is_nullable: true, is_deprecated: false, display_name: name, description: null, synonyms: [], role: null, semantic_type: null, default_aggregation: null, value_glossary: {}, is_exposed: true, is_pii: false, is_default_select: false, sample_values: [], created_at: at, updated_at: at })
  const ordersId = column(orders, 'order_id', 1)
  const ordersCustomer = column(orders, 'customer_id', 2)
  const customersId = column(customers, 'customer_id', 1)
  await col('data_sources').insertOne(source)
  await col('entities').insertMany([orders, customers])
  await col('entity_columns').insertMany([ordersId, ordersCustomer, customersId])
  ok('seeded 1 source, 2 entities, 3 columns')

  // data sources
  const sources = await ds.listDataSources()
  assert.equal(sources.length, 1)
  assert.equal(sources[0].id, source._id)
  assert.equal(sources[0].is_exposed_to_agent, 1)
  assert.equal((await ds.updateDataSource(source._id, { is_exposed_to_agent: false })).is_exposed_to_agent, 0)
  ok('data sources: list / get / update (booleans on the wire as 0/1, ids are strings)')

  // entities + columns
  assert.deepEqual((await ds.listEntitiesForSource(source._id)).map((e) => e.physical_name), ['customers', 'orders'])
  const updatedEntity = await ds.updateEntity(orders._id, { display_name: 'Đơn hàng', synonyms: ['order', 'đơn'], is_pii: true })
  assert.equal(updatedEntity.display_name, 'Đơn hàng')
  assert.equal(updatedEntity.synonyms, JSON.stringify(['order', 'đơn']))
  assert.equal(updatedEntity.is_pii, 1)
  assert.equal((await ds.listColumnsForEntity(orders._id)).length, 2)
  const updatedColumn = await ds.updateEntityColumn(ordersId._id, { role: 'key', semantic_type: 'id', is_default_select: true })
  assert.equal(updatedColumn.role, 'key') // stored as the VALUE, not the SQLAlchemy member name
  assert.equal((await col('entity_columns').findOne({ _id: ordersId._id })).role, 'key')
  assert.equal((await ds.updateEntityColumn(ordersId._id, { role: '' })).role, null) // '' from the FE select -> null
  ok('entities / columns: list, update, enum stored as value, empty select stored as null')

  // glossary
  const term = await ds.createGlossaryTerm({ term: 'đơn lớn', definition_text: 'đơn > 1tr', sql_expressions: ['amount > 1000000'], related_entity_ids: [orders._id] })
  assert.deepEqual(JSON.parse(term.related_entity_ids), [orders._id])
  assert.equal((await ds.updateGlossaryTerm(term.id, { synonyms: ['big order'] })).synonyms, JSON.stringify(['big order']))
  assert.equal((await ds.listGlossaryTerms()).length, 1)
  assert.equal(await ds.deleteGlossaryTerm(term.id), true)
  assert.equal(await ds.deleteGlossaryTerm(term.id), false)
  ok('glossary: create / update / list / delete')

  // browse + relationships (column pairs are a second collection)
  const browse = await ds.listBrowseEntities()
  assert.equal(browse.find((e) => e.id === orders._id).columns.length, 2)
  const rel = await ds.createRelationship({
    from_entity_id: customers._id, to_entity_id: orders._id, cardinality: '1:N', join_type_default: 'left',
    column_pairs: [{ from_column_id: customersId._id, to_column_id: ordersCustomer._id }],
  })
  assert.equal(rel.cardinality, '1:N')
  assert.equal(rel.from_entity_name, 'customers')
  assert.equal(rel.column_pairs.length, 1)
  assert.equal(rel.column_pairs[0].to_column_name, 'customer_id')
  const rel2 = await ds.updateRelationship(rel.id, { ...rel, cardinality: '1:1', column_pairs: [] })
  assert.equal(rel2.cardinality, '1:1')
  assert.equal(rel2.column_pairs.length, 0)
  assert.equal((await ds.listRelationships()).length, 1)
  assert.equal(await ds.deleteRelationship(rel.id), true)
  assert.equal(await col('relationship_column_pairs').countDocuments({ relationship_id: rel.id }), 0)
  ok('relationships: create / update / list / delete (+ column pairs cascade)')

  // metrics
  const metric = await ds.createMetric({ name: 'Doanh thu', base_entity_id: orders._id, aggregation: 'sum', measure_column_id: ordersId._id, synonyms: ['revenue'] })
  assert.equal(metric.base_entity_name, 'Đơn hàng')
  assert.equal(metric.aggregation, 'sum')
  assert.equal(metric.is_verified, 0)
  assert.equal((await ds.updateMetric(metric.id, { is_verified: true, unit: 'VND' })).is_verified, 1)
  assert.equal((await ds.listMetrics()).length, 1)
  assert.equal(await ds.deleteMetric(metric.id), true)
  ok('metrics: create / update / list / delete')

  // charts + dashboards: write charts the way the Python worker does (a chain conversation -> message ->
  // query_result -> chart), then run the reference UI's flows against them
  const conversationId = randomUUID(), messageId = randomUUID(), queryResultId = randomUUID()
  await col('conversations').insertOne({ _id: conversationId, title: 'Doanh thu theo tháng', created_at: at, updated_at: at })
  await col('messages').insertOne({ _id: messageId, conversation_id: conversationId, seq: 0, role: 'assistant', created_at: at })
  await col('query_results').insertOne({ _id: queryResultId, message_id: messageId, seq: 0, sql: 'select 1', row_count: 1, rows_json: [{ month: '1', revenue: 5 }], created_at: at })
  const chartDoc = (type, extra = {}) => ({ _id: randomUUID(), query_result_id: queryResultId, type, title: `Chart ${type}`, description: '', x: 'month', y_json: ['revenue'], rows_json: [{ month: '1', revenue: 5 }], recommended: type === 'bar', is_pinned: false, created_at: at, updated_at: at, ...extra })
  const bar = chartDoc('bar'), pie = chartDoc('pie'), legacy = chartDoc('line', { rows_json: [] }) // legacy chart without its own rows
  await col('charts').insertMany([bar, pie, legacy])

  // edit fields / colors (PATCH /data-studio/charts/:id)
  const edited = await ds.updateChart(bar._id, { title_override: 'Đổi tên', x_override: 'month', y_override: ['revenue'], color_overrides: { revenue: '#ff0000' }, label_overrides: { revenue: 'Doanh thu' } })
  assert.equal(edited.title_override, 'Đổi tên')
  assert.deepEqual(edited.color_overrides, { revenue: '#ff0000' })
  assert.deepEqual(edited.label_overrides, { revenue: 'Doanh thu' })
  const cleared = await ds.updateChart(bar._id, { title_override: '', y_override: [], color_overrides: {} })
  assert.equal(cleared.title_override, null)
  assert.equal(cleared.y_override, null) // [] clears the override
  assert.deepEqual(cleared.label_overrides, { revenue: 'Doanh thu' }) // untouched fields stay
  assert.equal((await ds.getChart(legacy._id)).rows.length, 1) // falls back to the query result's rows
  assert.equal(await ds.updateChart(randomUUID(), { title_override: 'x' }), undefined)
  ok('charts: edit fields / colors persisted, "[]"/"" clear an override, legacy chart falls back to shared rows')

  // dashboards: create, pin from chat, builder bulk-save, appearance
  const dash = await ds.createDashboard('Báo cáo', 'mô tả')
  assert.equal(dash.widgets.length, 0)
  assert.equal((await ds.createDashboard()).title, 'Dashboard chưa đặt tên')
  const pinned = await ds.pinChart(dash.id, bar._id)
  assert.equal(pinned.widgets.length, 1)
  assert.deepEqual([pinned.widgets[0].x, pinned.widgets[0].y, pinned.widgets[0].w, pinned.widgets[0].h], [0, 0, 6, 4])
  assert.equal(pinned.widgets[0].chart.title_override, null)
  assert.equal((await col('charts').findOne({ _id: bar._id })).is_pinned, true)
  const two = await ds.pinChart(dash.id, pie._id)
  assert.deepEqual([two.widgets[1].x, two.widgets[1].y], [6, 0]) // second chart goes to the right column
  assert.equal(await ds.pinChart(dash.id, randomUUID()), 'no-chart')
  assert.equal(await ds.pinChart(randomUUID(), bar._id), 'no-dashboard')
  const summaries = await ds.listDashboards()
  assert.equal(summaries.find((d) => d.id === dash.id).widget_count, 2)
  const available = await ds.availableCharts()
  assert.equal(available.length, 3)
  assert.equal(available[0].conversation_title, 'Doanh thu theo tháng')
  ok('dashboards: create, pin (2-per-row layout, is_pinned), summaries with widget_count, available charts')

  const text = await ds.addWidget(dash.id, { kind: 'text', text: 'Nhận xét', title: null })
  const textWidget = text.widgets.at(-1)
  assert.deepEqual([textWidget.kind, textWidget.w, textWidget.h, textWidget.y], ['text', 12, 2, 4])
  const [w1, w2] = pinned.widgets.length === 1 ? [pinned.widgets[0], two.widgets[1]] : []
  const saved = await ds.saveWidgets(dash.id, [
    { id: w2.id, kind: 'chart', x: 0, y: 0, w: 12, h: 6, title_override: 'Tiêu đề riêng' }, // moved + resized + renamed
    { id: null, kind: 'chart', chart_id: legacy._id, x: 0, y: 6, w: 6, h: 4 },              // new from the builder
    { id: textWidget.id, kind: 'text', x: 6, y: 6, w: 6, h: 2, text: 'Sửa nội dung' },
  ]) // w1 is missing -> deleted
  assert.equal(saved.widgets.length, 3)
  assert.deepEqual(saved.widgets.map((w) => w.kind), ['chart', 'chart', 'text'])
  assert.equal(saved.widgets[0].title_override, 'Tiêu đề riêng')
  assert.deepEqual([saved.widgets[0].w, saved.widgets[0].h], [12, 6])
  assert.equal(saved.widgets[2].text, 'Sửa nội dung')
  assert.equal(await col('dashboard_widgets').countDocuments({ _id: w1.id }), 0)
  assert.equal(await ds.saveWidgets(randomUUID(), []), undefined)
  ok('builder bulk-save: update kept, create new, delete missing, keep order and text')

  const themed = await ds.updateDashboard(dash.id, { title: 'Mới', appearance: { theme: 'dark', header: 'gradient', layout: 'two-col' } })
  assert.equal(themed.title, 'Mới')
  assert.equal(themed.description, 'mô tả') // untouched
  assert.deepEqual(themed.appearance, { theme: 'dark', header: 'gradient', layout: 'two-col' })
  await col('charts').deleteOne({ _id: pie._id }) // a widget whose chart was deleted disappears from the report
  assert.equal((await ds.getDashboard(dash.id)).widgets.length, 2)
  assert.equal(await ds.deleteDashboard(dash.id), true)
  assert.equal(await col('dashboard_widgets').countDocuments({ dashboard_id: dash.id }), 0)
  assert.equal(await ds.getDashboard(dash.id), undefined)
  ok('dashboard appearance saved; deleted charts vanish from the report; delete cascades widgets')

  console.log(`\nPASS — ${step} checks`)
} catch (error) {
  console.error('\nFAIL:', error)
  process.exitCode = 1
} finally {
  await getDb().dropDatabase().catch(() => {})
  await closeMongo()
}
