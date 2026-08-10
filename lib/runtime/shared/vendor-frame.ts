/**
 * "Is this frame my code, or somebody else's?"
 *
 * The question is asked in three places — grouping an issue, naming its
 * location, and collapsing a stack in the UI — and each had grown its own
 * regex with a different answer. That is worse than it sounds: a frame the
 * fingerprinter treats as application code and the trace view hides is a
 * trace whose highlighted line is nowhere to be seen.
 *
 * The two lists below are separate because the disagreement was real, not
 * accidental. A path under `.output/` or `.nuxt/` is *build output* — for the
 * fingerprinter that is the application's own code after bundling, and
 * skipping it would leave nothing to group on; for the reader it is generated
 * noise with a sourcemap pointing at the real file. So one predicate takes a
 * side rather than pretending the two cases are the same.
 */

/** Third-party code, on any reading: dependencies and the runtime itself. */
const THIRD_PARTY = /node_modules|node:internal|[/\\]nuxt[/\\]dist[/\\]|[/\\]vue[/\\]dist[/\\]|[/\\]chunks[/\\]nitro[/\\]/

/** Generated bundles. The application's code, but not as anyone wrote it. */
const BUILD_OUTPUT = /[/\\]\.output[/\\]|[/\\]\.nuxt[/\\]/

/**
 * Whether a frame should be skipped when deciding where a fault belongs.
 *
 * Used for grouping and for naming an issue's location. Build output does not
 * count as vendor here: after bundling, that *is* the application, and
 * treating it as foreign would leave every server error with no frame to
 * blame but Nitro's.
 */
export function isVendorFrame(frame: string): boolean {
  return THIRD_PARTY.test(frame)
}

/**
 * Whether a frame is worth collapsing out of a stack shown to a person.
 *
 * Wider than `isVendorFrame`: a reader gains nothing from a line inside a
 * generated bundle, since the frame above it already carries the resolved
 * original.
 */
export function isNoiseFrame(file: string): boolean {
  return THIRD_PARTY.test(file) || BUILD_OUTPUT.test(file)
}
