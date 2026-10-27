// Which Meta ads MCP tools the agent may use, and how (docs/meta-ads-mcp-plan.md D6). The gateway enforces this on
// every call whatever the runtime sends; a tool not listed here never reaches Meta. Names are Meta's own
// (developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server, 2026-10-27).
//
// Not listed on purpose: custom audience writes (`ads_update_custom_audience_users` sends hashed personal data),
// catalog / pixel / dataset writes, A/B test and lift writes, `ads_boost_ig_post` — out of scope until reviewed.

export type Tier = 'read' | 'write'

export interface ToolRule {
  tier: Tier
  /** always starts spending (activation) — the confirmation card says so */
  spends?: boolean
}

export const META_TOOLS: Record<string, ToolRule> = {
  // reporting
  ads_get_ad_entities: { tier: 'read' },
  ads_get_opportunity_score: { tier: 'read' },
  ads_insights_advertiser_context: { tier: 'read' },
  ads_insights_anomaly_signal: { tier: 'read' },
  ads_insights_auction_ranking_benchmarks: { tier: 'read' },
  ads_insights_industry_benchmark: { tier: 'read' },
  ads_insights_performance_trend: { tier: 'read' },
  // accounts, pages, fields, creatives
  ads_get_ad_accounts: { tier: 'read' },
  ads_get_ad_account_pages: { tier: 'read' },
  ads_get_user_pages: { tier: 'read' },
  ads_get_field_context: { tier: 'read' },
  ads_get_creatives: { tier: 'read' },
  ads_get_creative_ads: { tier: 'read' },
  ads_get_ad_preview: { tier: 'read' },
  ads_get_ad_images: { tier: 'read' },
  ads_get_ad_videos: { tier: 'read' },
  ads_library_search: { tier: 'read' },
  // diagnostics, help, history
  ads_get_errors: { tier: 'read' },
  ads_get_help_article: { tier: 'read' },
  ads_account_get_activity_logs: { tier: 'read' },
  // writes: Meta creates campaigns, ad sets and ads paused; activation starts spending
  ads_create_campaign: { tier: 'write' },
  ads_create_ad_set: { tier: 'write' },
  ads_create_creative: { tier: 'write' },
  ads_create_ad: { tier: 'write' },
  ads_update_entity: { tier: 'write' },
  ads_activate_entity: { tier: 'write', spends: true },
}

export function ruleOf(tool: string): ToolRule | undefined {
  return Object.hasOwn(META_TOOLS, tool) ? META_TOOLS[tool] : undefined
}

// Argument names that, in a write, can make the account spend more (budget, bid, turning something on).
const SPEND_KEYS = /budget|bid|spend_cap|status/i
const SHOWN_KEYS = [
  'name', 'objective', 'status', 'daily_budget', 'lifetime_budget', 'bid_amount', 'bid_strategy', 'optimization_goal',
  'billing_event', 'start_time', 'end_time', 'ad_account_id', 'account_id', 'campaign_id', 'adset_id', 'ad_id',
  'creative_id', 'entity_id', 'id', 'page_id',
]

function brief(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}

/** What the user is asked to confirm: the tool and the arguments that say what changes. Plain text, ≤1000 chars. */
export function summaryOf(tool: string, args: Record<string, unknown>): { summary: string; spends: boolean; adAccountId: string | undefined } {
  const rule = ruleOf(tool)
  const lines = [tool]
  const shown = new Set<string>()
  for (const key of SHOWN_KEYS) {
    if (args[key] === undefined) continue
    lines.push(`${key}: ${brief(args[key])}`)
    shown.add(key)
  }
  const rest = Object.keys(args).filter((key) => !shown.has(key))
  if (rest.length > 0) lines.push(`(+ ${rest.slice(0, 12).join(', ')}${rest.length > 12 ? ', ...' : ''})`)
  const spends =
    rule?.spends === true ||
    Object.entries(args).some(([key, value]) => SPEND_KEYS.test(key) && (key.toLowerCase() !== 'status' || String(value).toUpperCase() === 'ACTIVE'))
  const account = args.ad_account_id ?? args.account_id
  return { summary: lines.join('\n').slice(0, 1000), spends, adAccountId: typeof account === 'string' ? account.slice(0, 64) : undefined }
}
