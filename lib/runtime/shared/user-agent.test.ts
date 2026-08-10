import { describe, expect, it } from 'vitest'
import { parseUserAgent } from './user-agent'

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/16.3 Mobile/15E148 Safari/604.1'

const CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.6099.109 Safari/537.36'

const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1'

describe('parseUserAgent', () => {
  it('reads browser, os and device from a mobile Safari string', () => {
    expect(parseUserAgent(IPHONE)).toEqual({
      browser: 'Mobile Safari',
      browserVersion: 'Mobile Safari 16',
      os: 'iOS',
      osVersion: 'iOS 16.3',
      deviceType: 'mobile',
    })
  })

  it('reports desktop when the agent names no device', () => {
    const parsed = parseUserAgent(CHROME_WINDOWS)

    expect(parsed.browser).toBe('Chrome')
    expect(parsed.os).toBe('Windows')
    expect(parsed.deviceType).toBe('desktop')
  })

  it('distinguishes a tablet from a phone', () => {
    expect(parseUserAgent(IPAD).deviceType).toBe('tablet')
  })

  /**
   * A facet groups by value, so the patch number has to go: otherwise every
   * Chrome release becomes its own row and the breakdown says nothing.
   */
  it('keeps only the major browser version', () => {
    expect(parseUserAgent(CHROME_WINDOWS).browserVersion).toBe('Chrome 120')
  })

  /**
   * A version is read in three places, and only one of them has the browser
   * name nearby. Bare, `17` names nothing — and two browsers both at major 17
   * would group into a single row belonging to neither.
   */
  it('qualifies a version with the name it belongs to', () => {
    expect(parseUserAgent(IPAD).browserVersion).toBe('Mobile Safari 17')
    expect(parseUserAgent(IPAD).osVersion).toBe('iOS 17.2')
  })

  it('returns a usable shape for a missing or unparseable agent', () => {
    expect(parseUserAgent(undefined)).toEqual({ deviceType: 'other' })
    expect(parseUserAgent('').deviceType).toBe('other')
    // Not a UA at all, but ingest must not fail over it.
    expect(() => parseUserAgent('%%%')).not.toThrow()
  })

  it('caches without letting a hostile agent grow the map without bound', () => {
    for (let i = 0; i < 600; i++) {
      parseUserAgent(`Mozilla/5.0 (Fake ${i})`)
    }

    // Still correct after the cache has been cleared and refilled.
    expect(parseUserAgent(IPHONE).os).toBe('iOS')
  })
})
