import { expect, test } from "bun:test"
import path from "path"
import type { PluginInput } from "@opencode-ai/plugin"
import { ComplianceLogPlugin } from "../../src/compliance/plugin"
import { file } from "../../src/compliance/writer"
import { tmpdir } from "../fixture/fixture"

function input(dir: string) {
  return {
    client: undefined as never,
    project: undefined as never,
    directory: dir,
    worktree: dir,
    serverUrl: new URL("http://localhost"),
    $: Bun.$,
  } satisfies PluginInput
}

async function rows(dir: string, sessionID: string) {
  const text = await Bun.file(file(dir, sessionID)).text()
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> })
}

test("plugin logs session meta and user messages from chat.message", async () => {
  await using tmp = await tmpdir()
  const hooks = await ComplianceLogPlugin(input(tmp.path))

  await hooks["chat.message"]?.(
    {
      sessionID: "ses_user",
      agent: "default",
      model: { providerID: "openai", modelID: "gpt-5" },
      messageID: "msg_user",
      variant: "high",
    },
    {
      message: {
        id: "msg_user",
        sessionID: "ses_user",
        role: "user",
      } as never,
      parts: [
        {
          id: "part_user",
          messageID: "msg_user",
          sessionID: "ses_user",
          type: "text",
          text: "hello",
        } as never,
      ],
    },
  )

  const result = await rows(tmp.path, "ses_user")
  expect(result.map((item) => item.type)).toEqual(["session.meta", "user.message"])
  expect(result[1].data).toEqual({
    messageID: "msg_user",
    role: "user",
    parts: [{ type: "text", text: "hello" }],
  })
})

test("plugin logs native tool requests and outputs", async () => {
  await using tmp = await tmpdir()
  const hooks = await ComplianceLogPlugin(input(tmp.path))

  await hooks["tool.execute.before"]?.(
    {
      tool: "bash",
      sessionID: "ses_tool",
      callID: "call_1",
    },
    {
      args: {
        command: "echo hi",
      },
    },
  )

  await hooks["tool.execute.after"]?.(
    {
      tool: "bash",
      sessionID: "ses_tool",
      callID: "call_1",
      args: {
        command: "echo hi",
      },
    },
    {
      title: "done",
      output: "hi",
      metadata: {},
    },
  )

  const result = await rows(tmp.path, "ses_tool")
  expect(result.map((item) => item.type)).toEqual(["session.meta", "tool.call.request", "tool.call.output"])
  expect(result[1].data.tool).toBe("bash")
  expect(result[2].data.output).toBe("hi")
})

test("plugin logs permission events and completed assistant parts", async () => {
  await using tmp = await tmpdir()
  const hooks = await ComplianceLogPlugin(input(tmp.path))

  await hooks.event?.({
    event: {
      type: "message.updated",
      properties: {
        sessionID: "ses_evt",
        info: {
          id: "msg_assistant",
          sessionID: "ses_evt",
          role: "assistant",
          agent: "default",
          providerID: "openai",
          modelID: "gpt-5",
        },
      },
    } as never,
  })

  await hooks.event?.({
    event: {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_evt",
        part: {
          id: "part_assistant",
          messageID: "msg_assistant",
          sessionID: "ses_evt",
          type: "text",
          text: "done",
          time: { start: 1, end: 2 },
        },
      },
    } as never,
  })

  await hooks.event?.({
    event: {
      type: "permission.asked",
      properties: {
        id: "perm_1",
        sessionID: "ses_evt",
        permission: "bash",
        patterns: ["*"],
        metadata: { command: "rm -rf /tmp/demo" },
        always: ["*"],
        tool: {
          messageID: "msg_assistant",
          callID: "call_perm",
        },
      },
    } as never,
  })

  await hooks.event?.({
    event: {
      type: "permission.replied",
      properties: {
        sessionID: "ses_evt",
        requestID: "perm_1",
        reply: "reject",
      },
    } as never,
  })

  const result = await rows(tmp.path, "ses_evt")
  expect(result.map((item) => item.type)).toEqual([
    "assistant.message",
    "session.meta",
    "permission.asked",
    "permission.replied",
  ])
  expect(result[0].data).toEqual({
    messageID: "msg_assistant",
    partID: "part_assistant",
    partType: "text",
    text: "done",
    agent: "default",
    model: { providerID: "openai", modelID: "gpt-5" },
  })
  expect(result[2].data.requestID).toBe("perm_1")
  expect(result[3].data.reply).toBe("reject")
  expect(path.dirname(file(tmp.path, "ses_evt"))).toBe(path.join(tmp.path, ".opencode", "compliance-log"))
})
