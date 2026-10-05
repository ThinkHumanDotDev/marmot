import { describe, expect, it } from 'vitest'

import { markdownToText, renderMarkdown } from './markdown'

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

describe('markdownToText', () => {
  it('strips formatting and truncates', () => {
    expect(markdownToText('**Bold** [link](https://x) `code`')).toBe('Bold link code')
    expect(markdownToText('a'.repeat(200), 10)).toBe('aaaaaaaaa…')
  })
})
