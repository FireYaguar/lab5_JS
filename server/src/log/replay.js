import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const ID = /^[\w-]{1,100}$/ // лише літери/цифри/_/- → жодних «../» у шляху

export function replayPath(dir, id) {
  return ID.test(id) ? join(dir, `${id}.ndjson`) : null
}

// Асинхронний генератор: файл читається рядок за рядком, у пам’яті — лише поточний шматок.
export async function* readReplay(file) {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of lines) {
    if (line) yield JSON.parse(line)
  }
}

export async function listReplays(dir) {
  let names
  try {
    names = await readdir(dir)
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  const files = names.filter((n) => n.endsWith('.ndjson'))
  return Promise.all(
    files.map(async (name) => {
      const { size, mtime } = await stat(join(dir, name))
      return { id: name.slice(0, -'.ndjson'.length), bytes: size, modified: mtime.toISOString() }
    }),
  )
}
