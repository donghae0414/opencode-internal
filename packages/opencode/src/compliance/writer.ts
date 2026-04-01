import fs from "fs"
import path from "path"

const seen = new Set<string>()

export function file(dir: string, sessionID: string) {
  return path.join(dir, ".opencode", "compliance-log", `${sessionID}.jsonl`)
}

export function write(dir: string, sessionID: string, item: unknown) {
  const target = file(dir, sessionID)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.appendFileSync(target, JSON.stringify(item) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  })
  if (seen.has(target)) return
  seen.add(target)
  fs.chmodSync(target, 0o600)
}
