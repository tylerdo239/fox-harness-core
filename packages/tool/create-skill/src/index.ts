import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'fox-harness-tool-create-skill'
export const inject = ['tools', 'skills']

// Validation only — see README.md for why saving happens in apps/web. Limits
// mirror services/gateway/src/skills.ts, which stays the authority; checking
// here lets the model fix a bad proposal in the same turn.
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
const MAX_DESCRIPTION_CHARS = 280
const MAX_CONTENT_BYTES = 64 * 1024
const MAX_SKILLS_PER_USER = 50

export function apply(ctx: Context) {
  ctx.tools.register(
    defineTool({
      name: 'create_skill',
      description: [
        'Save a new personal skill for the current user so it can be reused in later conversations.',
        'Two steps. First turn: show the full skill (name, description, content) and stop —',
        'never call this in the same turn the user asked for it, even if they said "just create it",',
        'because they have not seen the content yet. Later turn: once the user approves, call this',
        'immediately with exactly what they approved, without asking again.',
        'The skill is private to this user and usable from their next message as /<name>.',
      ].join(' '),
      parameters: {
        name: {
          type: 'string',
          required: true,
          description: 'kebab-case slug, no spaces or accents, e.g. "bao-cao-tuan"',
        },
        description: {
          type: 'string',
          required: true,
          description: 'One sentence stating WHEN to use this skill, not what it is. At most 280 characters.',
        },
        content: {
          type: 'string',
          required: true,
          description: 'The skill body in Markdown. Self-contained: it cannot reference other files.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { name: { type: 'string', required: true } },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `Skill "${value.name}" is valid and is being saved to the user's private skill library. It can be used from the user's next message as /${value.name}.`,
          },
        ],
      },
      async execute(args, exec) {
        const skillName = args.name.trim()
        if (!NAME_RE.test(skillName)) {
          throw new Error(`invalid name "${skillName}": use kebab-case, e.g. "bao-cao-tuan"`)
        }
        const description = args.description.trim()
        if (!description || description.length > MAX_DESCRIPTION_CHARS) {
          throw new Error(`description is required and at most ${MAX_DESCRIPTION_CHARS} characters`)
        }
        const content = args.content.trim()
        if (!content || Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
          throw new Error(`content is required and at most ${MAX_CONTENT_BYTES} bytes`)
        }
        const skills = await ctx.skills.list({
          cwd: exec.agent?.session.header.cwd,
          signal: exec.signal,
          scope: exec.agent,
        })
        if (skills.some((skill) => skill.name === skillName)) {
          throw new Error(`a skill named "${skillName}" already exists — ask the user for a different name`)
        }
        if (skills.filter((skill) => skill.source === 'user-dsh').length >= MAX_SKILLS_PER_USER) {
          throw new Error(`the user already has ${MAX_SKILLS_PER_USER} skills — they must delete one in the Skills tab first`)
        }
        return { name: skillName }
      },
    }),
  )
}
