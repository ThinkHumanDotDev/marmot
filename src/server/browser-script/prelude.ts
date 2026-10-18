/**
 * The script API (#139), evaluated inside the QuickJS sandbox (`./sandbox.ts`) before the user's
 * script: `page`, `expect`, `test.step`, `vars`, `secrets`, `url` and `console`. A subset of
 * Playwright's API with the same names and semantics, built on two host functions that take an
 * operation name and JSON arguments; the host (`./bridge.ts`) allow-lists every operation.
 *
 * Locators are plain descriptions (a chain of `{ m, a }` steps) resolved on the host for every
 * action, so no host object ever enters the sandbox. Web-first assertions poll the host for the
 * current value and compare inside the sandbox: regular expressions written by the user only ever
 * run in QuickJS (under its CPU limits) or in the remote browser, never in the worker.
 */
export const GUEST_PRELUDE = String.raw`
(function () {
  'use strict'
  const host = globalThis.__marmot_host
  const sync = globalThis.__marmot_sync
  const init = JSON.parse(globalThis.__marmot_init)
  delete globalThis.__marmot_host
  delete globalThis.__marmot_sync
  delete globalThis.__marmot_init

  const LOCATOR = Symbol('locator')

  function encode(value, depth) {
    depth = depth || 0
    if (depth > 20) throw new Error('Argument is nested too deeply')
    if (value === undefined) return null
    if (value instanceof RegExp) return { __re: [value.source, value.flags] }
    if (typeof value === 'function') return { __fn: String(value) }
    if (value && value[LOCATOR]) return { __locator: encode(value[LOCATOR], depth + 1) }
    if (Array.isArray(value)) return value.map((item) => encode(item, depth + 1))
    if (value && typeof value === 'object') {
      const out = {}
      for (const key of Object.keys(value)) out[key] = encode(value[key], depth + 1)
      return out
    }
    return value
  }
  const call = (op, args) =>
    host(op, JSON.stringify(encode(args))).then((json) => JSON.parse(json))
  const callSync = (op, args) => JSON.parse(sync(op, JSON.stringify(encode(args))))
  const sleep = (ms) => call('sleep', [ms])

  const quote = (value) =>
    value instanceof RegExp ? String(value) : typeof value === 'string' ? JSON.stringify(value) : String(JSON.stringify(value))

  // ---- Locators ----------------------------------------------------------------------------------
  const CHAIN = [
    'locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByAltText',
    'getByTitle', 'getByTestId', 'frameLocator', 'contentFrame', 'first', 'last', 'nth', 'filter',
    'and', 'or',
  ]
  const LOCATOR_ACTIONS = [
    'click', 'dblclick', 'fill', 'clear', 'press', 'pressSequentially', 'type', 'check', 'uncheck',
    'setChecked', 'selectOption', 'selectText', 'hover', 'focus', 'blur', 'tap', 'dispatchEvent',
    'scrollIntoViewIfNeeded', 'waitFor', 'textContent', 'innerText', 'innerHTML', 'inputValue',
    'getAttribute', 'isVisible', 'isHidden', 'isEnabled', 'isDisabled', 'isChecked', 'isEditable',
    'count', 'allTextContents', 'allInnerTexts', 'boundingBox', 'evaluate', 'evaluateAll',
  ]

  function describe(chain) {
    return 'page' + chain.map((step) => '.' + step.m + '(' + step.a.map(quote).join(', ') + ')').join('')
  }

  function makeLocator(chain) {
    const locator = {}
    Object.defineProperty(locator, LOCATOR, { value: chain })
    for (const m of CHAIN) {
      locator[m] = (...args) => makeLocator(chain.concat([{ m: m, a: args }]))
    }
    for (const m of LOCATOR_ACTIONS) {
      locator[m] = (...args) => call('locator', [chain, m, args])
    }
    locator.all = async () => {
      const count = await call('locator', [chain, 'count', []])
      const out = []
      for (let i = 0; i < count; i++) out.push(makeLocator(chain.concat([{ m: 'nth', a: [i] }])))
      return out
    }
    locator.toString = () => describe(chain)
    return Object.freeze(locator)
  }

  // ---- Page --------------------------------------------------------------------------------------
  const PAGE_ACTIONS = [
    'goto', 'reload', 'goBack', 'goForward', 'waitForLoadState', 'waitForTimeout',
    'waitForSelector', 'title', 'content', 'setViewportSize', 'evaluate', 'click', 'fill', 'press',
    'check', 'uncheck', 'hover', 'focus', 'selectOption', 'textContent', 'innerText',
    'inputValue', 'isVisible', 'isHidden', 'getAttribute', 'dblclick', 'type',
  ]
  const page = {}
  for (const m of CHAIN.slice(0, 9)) {
    page[m] = (...args) => makeLocator([{ m: m, a: args }])
  }
  for (const m of PAGE_ACTIONS) {
    page[m] = (...args) => call('page', [m, args])
  }
  page.url = () => callSync('page.url', [])
  page.waitForURL = async (expected, options) => {
    if (!(expected instanceof RegExp)) return call('page', ['waitForURL', [expected, options]])
    await poll(async () => {
      const current = page.url()
      return { pass: expected.test(current), received: current }
    }, false, (options && options.timeout) || 30000, 'page.waitForURL(' + String(expected) + ')')
  }
  page.keyboard = {}
  for (const m of ['press', 'type', 'down', 'up', 'insertText']) {
    page.keyboard[m] = (...args) => call('keyboard', [m, args])
  }
  page.mouse = {}
  for (const m of ['click', 'dblclick', 'move', 'down', 'up', 'wheel']) {
    page.mouse[m] = (...args) => call('mouse', [m, args])
  }
  Object.freeze(page.keyboard)
  Object.freeze(page.mouse)
  Object.freeze(page)

  // ---- expect ------------------------------------------------------------------------------------
  const DEFAULT_EXPECT_TIMEOUT = 5000
  const normalize = (text) => String(text == null ? '' : text).replace(/\s+/g, ' ').trim()

  /** Poll \`probe\` until it passes (or, negated, fails) or the timeout ends. */
  async function poll(probe, negate, timeout, label) {
    const deadline = Date.now() + timeout
    const intervals = [0, 100, 250, 500, 1000]
    let attempt = 0
    let last
    for (;;) {
      try {
        last = await probe()
      } catch (err) {
        last = { pass: false, received: undefined, error: err && err.message ? err.message : String(err) }
      }
      if (last.pass !== negate) return
      if (Date.now() >= deadline) break
      const wait = intervals[Math.min(attempt + 1, intervals.length - 1)]
      attempt++
      await sleep(Math.max(0, Math.min(wait, deadline - Date.now())))
    }
    let message = label + ' failed' + (negate ? ' (negated)' : '')
    if (last && last.expected !== undefined) message += '\nExpected: ' + quote(last.expected)
    if (last && last.received !== undefined) message += '\nReceived: ' + quote(last.received)
    if (last && last.error) message += '\nError: ' + last.error
    message += '\nTimeout: ' + timeout + 'ms'
    throw new Error(message)
  }

  const matchText = (expected, received, contains) => {
    if (expected instanceof RegExp) return expected.test(received)
    const want = normalize(expected)
    return contains ? normalize(received).indexOf(want) !== -1 : normalize(received) === want
  }

  function deepEqual(a, b) {
    if (Object.is(a, b)) return true
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
    if (Array.isArray(a) !== Array.isArray(b)) return false
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    if (ka.length !== kb.length) return false
    for (const key of ka) if (!deepEqual(a[key], b[key])) return false
    return true
  }

  function locatorMatchers(chain, negate, label) {
    const act = (m, args) => call('locator', [chain, m, args || []])
    const state = (m, expectedValue) => (options) =>
      poll(async () => ({ pass: (await act(m)) === true, expected: expectedValue }), negate, timeoutOf(options), label(m.replace(/^is/, 'toBe')))
    const timeoutOf = (options) => (options && typeof options.timeout === 'number' ? options.timeout : DEFAULT_EXPECT_TIMEOUT)
    return {
      toBeVisible: state('isVisible'),
      toBeHidden: state('isHidden'),
      toBeEnabled: state('isEnabled'),
      toBeDisabled: state('isDisabled'),
      toBeChecked: state('isChecked'),
      toBeEditable: state('isEditable'),
      toBeFocused: state('isFocused'),
      toBeAttached: (options) =>
        poll(async () => {
          const count = await act('count')
          return { pass: count > 0, received: count + ' element(s)' }
        }, negate, timeoutOf(options), label('toBeAttached')),
      toHaveCount: (expected, options) =>
        poll(async () => {
          const count = await act('count')
          return { pass: count === expected, expected: expected, received: count }
        }, negate, timeoutOf(options), label('toHaveCount')),
      toHaveText: (expected, options) => textMatcher(expected, options, false, 'toHaveText'),
      toContainText: (expected, options) => textMatcher(expected, options, true, 'toContainText'),
      toHaveValue: (expected, options) =>
        poll(async () => {
          const value = await act('inputValue')
          return { pass: matchText(expected, value, false), expected: expected, received: value }
        }, negate, timeoutOf(options), label('toHaveValue')),
      toHaveAttribute: (name, expected, options) =>
        poll(async () => {
          const value = await act('getAttribute', [name])
          const pass = expected === undefined || (expected && typeof expected === 'object' && !(expected instanceof RegExp))
            ? value !== null
            : value !== null && matchText(expected, value, false)
          return { pass: pass, expected: expected, received: value }
        }, negate, timeoutOf(expected && typeof expected === 'object' && !(expected instanceof RegExp) ? expected : options), label('toHaveAttribute')),
      toHaveClass: (expected, options) =>
        poll(async () => {
          const value = (await act('getAttribute', ['class'])) || ''
          return { pass: matchText(expected, value, false), expected: expected, received: value }
        }, negate, timeoutOf(options), label('toHaveClass')),
    }

    function textMatcher(expected, options, contains, name) {
      return poll(async () => {
        const texts = (await act(options && options.useInnerText ? 'allInnerTexts' : 'allTextContents')) || []
        if (Array.isArray(expected)) {
          const pass = texts.length === expected.length && expected.every((item, i) => matchText(item, texts[i], contains))
          return { pass: pass, expected: expected, received: texts }
        }
        if (texts.length !== 1) {
          return { pass: false, expected: expected, received: texts.length + ' elements' }
        }
        return { pass: matchText(expected, texts[0], contains), expected: expected, received: normalize(texts[0]) }
      }, negate, timeoutOf(options), label(name))
    }
  }

  function pageMatchers(negate) {
    const timeoutOf = (options) => (options && typeof options.timeout === 'number' ? options.timeout : DEFAULT_EXPECT_TIMEOUT)
    return {
      toHaveURL: (expected, options) =>
        poll(async () => {
          const current = page.url()
          return { pass: matchText(expected, current, false), expected: expected, received: current }
        }, negate, timeoutOf(options), 'expect(page).toHaveURL'),
      toHaveTitle: (expected, options) =>
        poll(async () => {
          const title = await page.title()
          return { pass: matchText(expected, title, false), expected: expected, received: title }
        }, negate, timeoutOf(options), 'expect(page).toHaveTitle'),
    }
  }

  function valueMatchers(actual, negate) {
    const check = (pass, name, expected) => {
      if (pass === negate) {
        let message = 'expect(received)' + (negate ? '.not' : '') + '.' + name + '() failed'
        if (expected !== undefined) message += '\nExpected: ' + quote(expected)
        message += '\nReceived: ' + quote(actual)
        throw new Error(message)
      }
    }
    return {
      toBe: (expected) => check(Object.is(actual, expected), 'toBe', expected),
      toEqual: (expected) => check(deepEqual(actual, expected), 'toEqual', expected),
      toStrictEqual: (expected) => check(deepEqual(actual, expected), 'toStrictEqual', expected),
      toBeTruthy: () => check(!!actual, 'toBeTruthy'),
      toBeFalsy: () => check(!actual, 'toBeFalsy'),
      toBeDefined: () => check(actual !== undefined, 'toBeDefined'),
      toBeUndefined: () => check(actual === undefined, 'toBeUndefined'),
      toBeNull: () => check(actual === null, 'toBeNull'),
      toBeNaN: () => check(Number.isNaN(actual), 'toBeNaN'),
      toContain: (expected) =>
        check(actual != null && typeof actual.indexOf === 'function' && actual.indexOf(expected) !== -1, 'toContain', expected),
      toMatch: (expected) =>
        check(typeof actual === 'string' && (expected instanceof RegExp ? expected.test(actual) : actual.indexOf(expected) !== -1), 'toMatch', expected),
      toHaveLength: (expected) => check(actual != null && actual.length === expected, 'toHaveLength', expected),
      toBeGreaterThan: (expected) => check(actual > expected, 'toBeGreaterThan', expected),
      toBeGreaterThanOrEqual: (expected) => check(actual >= expected, 'toBeGreaterThanOrEqual', expected),
      toBeLessThan: (expected) => check(actual < expected, 'toBeLessThan', expected),
      toBeLessThanOrEqual: (expected) => check(actual <= expected, 'toBeLessThanOrEqual', expected),
    }
  }

  function makeExpect(actual, negate) {
    let matchers
    if (actual === page) {
      matchers = pageMatchers(negate)
    } else if (actual && actual[LOCATOR]) {
      const chain = actual[LOCATOR]
      matchers = locatorMatchers(chain, negate, (name) =>
        'expect(' + describe(chain) + ')' + (negate ? '.not' : '') + '.' + name)
    } else {
      matchers = valueMatchers(actual, negate)
    }
    if (!negate) Object.defineProperty(matchers, 'not', { get: () => makeExpect(actual, true) })
    return Object.freeze(matchers)
  }
  const expect = (actual) => makeExpect(actual, false)

  // ---- test.step ---------------------------------------------------------------------------------
  const errorMessage = (err) => (err && err.message ? String(err.message) : String(err))
  const test = Object.freeze({
    step: async (name, body) => {
      const id = callSync('step.start', [String(name)])
      try {
        const result = await body()
        callSync('step.end', [id, null])
        return result
      } catch (err) {
        callSync('step.end', [id, errorMessage(err)])
        throw err
      }
    },
  })

  // ---- console -----------------------------------------------------------------------------------
  const show = (value) => (typeof value === 'string' ? value : (() => {
    try { return JSON.stringify(value) } catch (e) { return String(value) }
  })())
  const consoleApi = {}
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    consoleApi[level] = (...args) => { callSync('log', [level, args.map(show).join(' ')]) }
  }

  const freezeDeep = (value) => {
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) freezeDeep(value[key])
      Object.freeze(value)
    }
    return value
  }

  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value: value, writable: false, configurable: false, enumerable: false })
  define('page', page)
  define('expect', expect)
  define('test', test)
  define('vars', freezeDeep(init.vars || {}))
  define('secrets', freezeDeep(init.secrets || {}))
  define('url', init.url || '')
  define('console', Object.freeze(consoleApi))
  define('__marmot_run', (fn) => Promise.resolve().then(fn).then(() => undefined, (err) => {
    throw new Error(errorMessage(err))
  }))
})()
`
