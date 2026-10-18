import { describe, expect, it } from 'vitest'

import { markdownToText, renderMarkdown, renderMarkdownDocument } from './markdown'

describe('renderMarkdown', () => {
  it('renders paragraphs, inline formatting, lists and links', () => {
    expect(renderMarkdown('Hello **world**\nnew line\n\n- one\n- _two_')).toBe(
      '<p>Hello <strong>world</strong><br/>new line</p><ul><li>one</li><li><em>two</em></li></ul>',
    )
    expect(renderMarkdown('See [docs](https://example.com/a?b=1) and `code`')).toBe(
      '<p>See <a href="https://example.com/a?b=1" rel="noopener noreferrer nofollow" target="_blank">docs</a> and <code>code</code></p>',
    )
  })

  it('escapes HTML and drops unsafe link schemes', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).toBe(
      '<p>&lt;img src=x onerror=alert(1)&gt;</p>',
    )
    expect(renderMarkdown('[x](javascript:alert(1))')).toBe('<p>x</p>')
    expect(renderMarkdown('')).toBe('')
  })

  it('does not treat snake_case or multiplication as emphasis', () => {
    expect(renderMarkdown('my_var_name and 2*3*4')).toBe('<p>my_var_name and 2*3*4</p>')
  })
})

describe('renderMarkdownDocument', () => {
  it('renders headings, lists, code fences and rules', () => {
    expect(
      renderMarkdownDocument(
        '## Summary\nCheckout **failed**.\n\n## Action items\n- one\n- two\n  continued\n\n1. first\n2) second\n\n---\n```\n<b>raw</b>\n```',
      ),
    ).toBe(
      '<h4>Summary</h4><p>Checkout <strong>failed</strong>.</p><h4>Action items</h4><ul><li>one</li><li>two<br/>continued</li></ul><ol><li>first</li><li>second</li></ol><hr/><pre><code>&lt;b&gt;raw&lt;/b&gt;</code></pre>',
    )
  })

  it('escapes HTML everywhere and drops unsafe link schemes', () => {
    expect(renderMarkdownDocument('# <script>alert(1)</script>')).toBe(
      '<h3>&lt;script&gt;alert(1)&lt;/script&gt;</h3>',
    )
    expect(
      renderMarkdownDocument('- [x](javascript:alert(1))\n- <img src=x onerror=alert(1)>'),
    ).toBe('<ul><li>x</li><li>&lt;img src=x onerror=alert(1)&gt;</li></ul>')
    expect(renderMarkdownDocument('[a](https://x.test/"onmouseover="alert(1))')).not.toContain(
      '"onmouseover',
    )
    expect(renderMarkdownDocument('```\nunterminated <i>')).toBe(
      '<pre><code>unterminated &lt;i&gt;</code></pre>',
    )
    expect(renderMarkdownDocument('')).toBe('')
  })
})

describe('markdownToText', () => {
  it('strips formatting and truncates', () => {
    expect(markdownToText('**Bold** [link](https://x) `code`')).toBe('Bold link code')
    expect(markdownToText('a'.repeat(200), 10)).toBe('aaaaaaaaa…')
  })
})
