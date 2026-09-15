import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { PythonKernel } from './kernel.ts'

export const name = 'fox-harness-tool-python-repl'
export const inject = ['tools']

const CELL_TIMEOUT_MS = 120_000

// `python` tool for the data-analysis flow (docs/rlm-transfer-plan.md, giai đoạn 2):
// one persistent IPython process per worker container, i.e. per conversation.
export function apply(ctx: Context) {
  const kernel = new PythonKernel()
  ctx.effect(() => () => kernel.stop(), 'fox-harness-tool-python-repl.kernel')

  ctx.tools.register(
    defineTool({
      name: 'python',
      description: [
        'Run Python code in a persistent IPython session that belongs to this conversation.',
        'Variables, imports and loaded data stay available across calls and turns until the session restarts.',
        "The working directory holds the user's data files; save outputs there too.",
        'Preloaded helpers: list_datasets(), load_dataset(name=None) → DataFrame, profile_dataset(name=None), save_artifact(path, content) → path under generated/.',
        'Only printed output and the value of the last expression are returned, truncated after 20000 characters — print summaries, not whole tables.',
        'Open matplotlib figures are saved as PNG files under generated/ and their paths are returned.',
        `A call running longer than ${CELL_TIMEOUT_MS / 1000} seconds stops the session.`,
      ].join(' '),
      parameters: {
        code: { type: 'string', required: true, description: 'Python code to run.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { output: { type: 'string', required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: value.output }],
      },
      async execute(args, exec) {
        const cwd = exec.agent?.session.header.cwd ?? process.cwd()
        const output = await kernel.run(args.code, cwd, CELL_TIMEOUT_MS, exec.signal)
        return { output }
      },
    }),
  )
}
