import { expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { file, write } from "../../src/compliance/writer"

test("writer creates the compliance log file and appends jsonl records", async () => {
  await using tmp = await tmpdir()
  write(tmp.path, "ses_test", { ok: 1 })
  write(tmp.path, "ses_test", { ok: 2 })

  const target = file(tmp.path, "ses_test")
  expect(target).toBe(path.join(tmp.path, ".opencode", "compliance-log", "ses_test.jsonl"))

  const text = await Bun.file(target).text()
  const rows = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { ok: number })

  expect(rows).toEqual([{ ok: 1 }, { ok: 2 }])
})
