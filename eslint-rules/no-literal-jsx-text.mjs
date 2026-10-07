/**
 * `marmot/no-literal-jsx-text`: user-facing text in JSX must come from next-intl
 * (`src/i18n/messages/en.json`), not from string literals. Reports
 *
 * - JSX text containing a letter (`<p>Save</p>`),
 * - string literals rendered as children (`<p>{'Save'}</p>`, `{cond ? 'Yes' : 'No'}`),
 * - literal values of text attributes (`placeholder`, `title`, `alt`, `aria-label`, `label`, …).
 *
 * Not reported: text without letters (`·`, `—`, `%`), text inside `<code>`, `<pre>`, `<kbd>` and
 * `<samp>`, technical values (`https://…`, `example.com`, `my-node`, `{ "key": "value" }`,
 * `/status/`; see `isTechnical`) and anything listed in `allow` (product names, key caps).
 * Other untranslatable text (a SQL placeholder) takes an `eslint-disable-next-line` comment
 * giving the reason.
 */

const DEFAULT_ATTRIBUTES = [
  'alt',
  'aria-description',
  'aria-label',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'description',
  'label',
  'placeholder',
  'title',
]

/** At least one letter in any script. */
const LETTER = /\p{L}/u

/** Elements whose text is code or key caps, never prose. */
const CODE_ELEMENTS = new Set(['code', 'kbd', 'pre', 'samp'])

/** Markup, URLs and paths: `{ "a": 1 }`, `<request/>`, `a=b`, `https://…`, `/status/`, `$.status`. */
const CODE_LIKE = /[{}<>=]|:\/\/|^[/$#]|^-{3,}/

/** A word that cannot be prose: an identifier, host or path (`my-node`, `api.example.com:443`). */
const isTechnicalWord = (word) =>
  /^[a-z0-9]/.test(word) ? /^[\w.:+/@-]+$/.test(word) : /[-_:/$#@0-9]|\w\.\w/.test(word)

/**
 * Technical text that stays the same in every language: code-like text, a single identifier-like
 * word, or several words that each carry a technical character (`kafka1:9092 kafka2:9092`).
 */
export function isTechnical(text) {
  if (CODE_LIKE.test(text)) return true
  const words = text.split(' ')
  if (words.length === 1) return isTechnicalWord(words[0])
  return words.every((word) => /[-_:/$#@0-9]|\w\.\w/.test(word))
}

export default {
  meta: {
    type: 'suggestion',
    docs: { description: 'Disallow literal user-facing text in JSX; use next-intl messages' },
    schema: [
      {
        type: 'object',
        properties: {
          allow: { type: 'array', items: { type: 'string' } },
          attributes: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      literal: 'Literal text "{{text}}" in JSX: move it to src/i18n/messages/en.json.',
    },
  },
  create(context) {
    const options = context.options[0] ?? {}
    const allow = new Set(options.allow ?? [])
    const attributes = new Set(options.attributes ?? DEFAULT_ATTRIBUTES)

    const check = (node, raw) => {
      const text = raw.replace(/\s+/g, ' ').trim()
      if (!text || !LETTER.test(text) || allow.has(text) || isTechnical(text)) return
      if (insideCode(node)) return
      context.report({ node, messageId: 'literal', data: { text: text.slice(0, 40) } })
    }

    /** String literals an expression can evaluate to (`a ? 'x' : 'y'`, `a || 'x'`, `` `x` ``). */
    const checkExpression = (node) => {
      if (!node) return
      switch (node.type) {
        case 'Literal':
          if (typeof node.value === 'string') check(node, node.value)
          return
        case 'TemplateLiteral':
          for (const quasi of node.quasis) check(quasi, quasi.value.cooked ?? '')
          return
        case 'ConditionalExpression':
          checkExpression(node.consequent)
          checkExpression(node.alternate)
          return
        case 'LogicalExpression':
          checkExpression(node.right)
          if (node.operator !== '&&') checkExpression(node.left)
          return
        default:
      }
    }

    const insideCode = (node) => {
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (parent.type !== 'JSXElement') continue
        const name = parent.openingElement.name
        return name.type === 'JSXIdentifier' && CODE_ELEMENTS.has(name.name)
      }
      return false
    }

    const isJsxChild = (node) =>
      node.parent?.type === 'JSXElement' || node.parent?.type === 'JSXFragment'

    return {
      JSXText(node) {
        check(node, node.value)
      },
      JSXExpressionContainer(node) {
        if (isJsxChild(node)) checkExpression(node.expression)
      },
      JSXAttribute(node) {
        const name =
          node.name.type === 'JSXNamespacedName'
            ? `${node.name.namespace.name}:${node.name.name.name}`
            : node.name.name
        if (!attributes.has(name) || !node.value) return
        if (node.value.type === 'Literal') check(node.value, String(node.value.value))
        else if (node.value.type === 'JSXExpressionContainer')
          checkExpression(node.value.expression)
      },
    }
  },
}
