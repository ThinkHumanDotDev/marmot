import { describe, expect, it } from 'vitest'

import { sanitizeSvg, SvgRejectedError } from './svg'

const wrap = (inner: string, attrs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"${attrs}>${inner}</svg>`

describe('sanitizeSvg', () => {
  it('keeps plain shapes, gradients and local references', () => {
    const input = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generator: test -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 16 16">
  <title>Acme &amp; Co</title>
  <defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs>
  <circle cx="8" cy="8" r="7" fill="url(#g)" style="stroke: #000; stroke-width: 1"/>
  <use xlink:href="#g"/>
</svg>`
    const out = sanitizeSvg(input)
    expect(out).toContain('<title>Acme &amp; Co</title>')
    expect(out).toContain('fill="url(#g)"')
    expect(out).toContain('style="stroke:#000;stroke-width:1"')
    expect(out).toContain('<use xlink:href="#g"/>')
    expect(out.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(out).not.toContain('<?xml')
    expect(out).not.toContain('Generator')
  })

  it('drops scripts, event handlers, foreign content and external references', () => {
    const out = sanitizeSvg(
      wrap(
        `<script>alert(1)</script>
         <foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>
         <a href="javascript:alert(1)"><rect width="1" height="1"/></a>
         <image href="https://evil.test/x.png"/>
         <style>@import url(https://evil.test/x.css);</style>
         <animate attributeName="href" to="javascript:alert(1)"/>
         <rect width="2" height="2" onclick="alert(1)" onload="alert(1)" fill="url(https://evil.test/#x)"/>
         <use href="https://evil.test/sprite.svg#a"/>
         <circle r="1" style="fill:url(javascript:alert(1))"/>
         <path d="M0 0" style="behavior:url(x.htc);fill:red"/>
         <circle r="2" fill="&#106;avascript:alert(1)"/>`,
        ' onload="alert(1)"',
      ),
    )
    expect(out).not.toMatch(
      /script|alert|onclick|onload|evil|foreignObject|<a |<image|<style|animate|behavior/i,
    )
    expect(out).toContain('<rect width="2" height="2"/>')
    // A style with any unsafe part is dropped as a whole.
    expect(out).toContain('<path d="M0 0"/>')
    expect(out).toContain('<use/>')
  })

  it('drops metadata from editors such as Inkscape', () => {
    const out = sanitizeSvg(
      wrap(
        '<metadata><rdf:RDF><cc:Work/></rdf:RDF></metadata><sodipodi:namedview pagecolor="#fff"/><path d="M1 1" inkscape:label="x"/>',
        ' xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"',
      ),
    )
    expect(out).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M1 1"/></svg>',
    )
  })

  it.each([
    [
      'a DOCTYPE with entities',
      '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>',
    ],
    ['CDATA', wrap('<text><![CDATA[<script>alert(1)</script>]]></text>')],
    ['a processing instruction', `<?xml-stylesheet href="x.css"?>${wrap('')}`],
    ['a non-SVG root', '<html><body>hi</body></html>'],
    ['unbalanced tags', '<svg xmlns="http://www.w3.org/2000/svg"><g></svg>'],
    ['unclosed root', '<svg xmlns="http://www.w3.org/2000/svg"><g/>'],
    ['two roots', `${wrap('')}${wrap('')}`],
    ['malformed markup', wrap('<rect width=1/>')],
    ['plain text', 'hello'],
    ['empty input', ''],
  ])('rejects %s', (_label, input) => {
    expect(() => sanitizeSvg(input)).toThrow(SvgRejectedError)
  })

  it('escapes stray entities in text', () => {
    expect(sanitizeSvg(wrap('<title>A &nbsp; B</title>'))).toContain(
      '<title>A &amp;nbsp; B</title>',
    )
  })
})
