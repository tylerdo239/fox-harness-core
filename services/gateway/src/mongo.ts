// MongoDB connection for the Data Studio semantic layer (docs/data-studio-mongodb-plan.md).
// Replaces the shared sqlite file gateway used to open directly. The Python side
// (packages/tool/data-studio-agent/python/src/database/mongodb.py) connects to the SAME
// database with the same URL/name rules, so both must keep resolving the database identically:
// a database named in the URL path wins, otherwise `mongodbDatabaseName`.

import { MongoClient, type Collection, type Db } from 'mongodb'

import { config } from './config.ts'

// Every document: `_id` is an app-generated uuid4 string (not ObjectId), timestamps are UTC Dates —
// same contract as the Python crud_mongo layer, which is the schema's reference implementation.
export interface Doc {
  _id: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

const client = new MongoClient(config.mongodbUrl)

function databaseNameFromUrl(url: string): string | undefined {
  return /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/.exec(url)?.[1]
}

let cached: Db | undefined

export function getDb(): Db {
  cached ??= client.db(databaseNameFromUrl(config.mongodbUrl) ?? config.mongodbDatabaseName)
  return cached
}

export function col(name: string): Collection<Doc> {
  return getDb().collection<Doc>(name)
}

export async function checkMongoConnection(): Promise<boolean> {
  try {
    await client.connect()
    await getDb().command({ ping: 1 })
    return true
  } catch (error) {
    // The URL can carry credentials — log only the message, never the connection string.
    console.error('[gateway] MongoDB connection check failed:', error instanceof Error ? error.message : 'unknown error')
    return false
  }
}

// Idempotent (createIndex on an identical spec is a no-op), safe to run on every boot. Mirrors
// crud_mongo's ensure_indexes() in the Python package — keep the two lists identical.
//
// Tolerant on purpose: a staging database that already holds data (written by
// bot-data-studio-api, which creates no indexes) may violate a unique index; that must not stop the
// gateway from booting, so each failure is logged and skipped.
export async function ensureIndexes(): Promise<void> {
  const db = getDb()
  const results = await Promise.allSettled([
    db.collection('data_sources').createIndex({ name: 1 }, { unique: true }),
    db.collection('entities').createIndex({ data_source_id: 1, physical_name: 1 }, { unique: true }),
    db.collection('entities').createIndex({ data_source_id: 1, is_deprecated: 1 }),
    db.collection('entities').createIndex({ is_exposed: 1, is_deprecated: 1 }),
    db.collection('entity_columns').createIndex({ entity_id: 1, physical_name: 1 }, { unique: true }),
    db.collection('entity_columns').createIndex({ entity_id: 1, is_deprecated: 1, ordinal: 1 }),
    db.collection('relationships').createIndex({ from_entity_id: 1 }),
    db.collection('relationships').createIndex({ to_entity_id: 1 }),
    db.collection('relationship_column_pairs').createIndex({ relationship_id: 1, seq: 1 }),
    db.collection('metrics').createIndex({ name: 1 }),
    db.collection('business_glossary').createIndex({ term: 1 }),
    db.collection('verified_queries').createIndex({ is_verified: 1 }),
    db.collection('conversations').createIndex({ updated_at: -1 }),
    db.collection('messages').createIndex({ conversation_id: 1, seq: 1 }, { unique: true }),
    db.collection('query_results').createIndex({ message_id: 1, seq: 1 }),
    db.collection('charts').createIndex({ query_result_id: 1 }),
    db.collection('dashboards').createIndex({ updated_at: -1 }),
    db.collection('dashboard_widgets').createIndex({ dashboard_id: 1, seq: 1 }),
  ])
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[gateway] ensureIndexes: skipped an index:', result.reason instanceof Error ? result.reason.message : result.reason)
    }
  }
}

export async function closeMongo(): Promise<void> {
  await client.close()
}
