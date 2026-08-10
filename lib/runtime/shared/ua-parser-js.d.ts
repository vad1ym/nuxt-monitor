/**
 * Types for `ua-parser-js@1.x`, which ships none of its own.
 *
 * `@types/ua-parser-js` on npm still describes 0.7 and disagrees with the 1.x
 * result shape, so the surface we actually use is declared here instead of
 * carrying a dependency that is wrong about it. Only the fields
 * `parseUserAgent` reads are described.
 */
declare module 'ua-parser-js' {
  interface UAParserResult {
    browser: { name?: string, version?: string, major?: string }
    os: { name?: string, version?: string }
    device: { vendor?: string, model?: string, type?: string }
  }

  /** Callable with `new`; 1.x is CommonJS, so this is the default export. */
  class UAParser {
    constructor(ua?: string)
    getResult: () => UAParserResult
  }

  export default UAParser
}
