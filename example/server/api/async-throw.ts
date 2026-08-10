/**
 * A rejection surfacing from an awaited call. The stack points into the async
 * frame rather than the handler, which is what makes these worth capturing.
 */
export default defineEventHandler(async () => {
  const record = await loadRecord(17)

  return { record }
})

async function loadRecord(id: number): Promise<{ id: number }> {
  await new Promise(resolve => setTimeout(resolve, 1))

  throw new Error(`Record ${id} is missing from the upstream store`)
}
