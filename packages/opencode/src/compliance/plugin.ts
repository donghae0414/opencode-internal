import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import * as Log from "@opencode-ai/core/util/log"
import { write } from "./writer"

const log = Log.create({ service: "compliance" })

function obj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function str(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function num(value: unknown) {
  return typeof value === "number" ? value : undefined
}

function part(value: unknown) {
  if (!obj(value)) return { type: "unknown" }
  const type = str(value.type) ?? "unknown"
  if (type === "text") return { type, text: str(value.text) ?? "" }
  if (type === "reasoning") return { type, text: str(value.text) ?? "" }
  if (type === "file") {
    return {
      type,
      mime: str(value.mime) ?? str(value.mediaType),
      filename: str(value.filename),
    }
  }
  if (type === "agent") return { type, name: str(value.name) }
  if (type === "subtask") {
    return {
      type,
      agent: str(value.agent),
      description: str(value.description),
      prompt: str(value.prompt),
    }
  }
  return { type }
}

function line(sessionID: string, type: string, data: Record<string, unknown>) {
  return {
    v: 1,
    ts: new Date().toISOString(),
    sessionID,
    type,
    data,
  }
}

export async function ComplianceLogPlugin(input: PluginInput): Promise<Hooks> {
  const meta = new Set<string>()
  const parts = new Set<string>()
  const msgs = new Map<string, { agent?: string; model?: { providerID: string; modelID: string } }>()

  const emit = (sessionID: string, type: string, data: Record<string, unknown>) => {
    try {
      write(input.directory, sessionID, line(sessionID, type, data))
    } catch (error) {
      log.warn("write failed", { error, sessionID, type })
    }
  }

  const boot = (sessionID: string, data: Record<string, unknown>) => {
    if (meta.has(sessionID)) return
    meta.add(sessionID)
    emit(sessionID, "session.meta", data)
  }

  return {
    "chat.message"(ctx, out) {
      boot(ctx.sessionID, {
        directory: input.directory,
        worktree: input.worktree,
        agent: ctx.agent,
        model: ctx.model,
        variant: ctx.variant,
      })
      emit(ctx.sessionID, "user.message", {
        messageID: out.message.id,
        role: "user",
        parts: out.parts.map(part),
      })
      return Promise.resolve()
    },
    "tool.execute.before"(ctx, out) {
      boot(ctx.sessionID, {
        directory: input.directory,
        worktree: input.worktree,
      })
      emit(ctx.sessionID, "tool.call.request", {
        tool: ctx.tool,
        callID: ctx.callID,
        args: obj(out.args) ? out.args : { value: out.args },
      })
      return Promise.resolve()
    },
    "tool.execute.after"(ctx, out) {
      boot(ctx.sessionID, {
        directory: input.directory,
        worktree: input.worktree,
      })
      emit(ctx.sessionID, "tool.call.output", {
        tool: ctx.tool,
        callID: ctx.callID,
        args: obj(ctx.args) ? ctx.args : { value: ctx.args },
        title: out.title,
        output: out.output,
        metadata: obj(out.metadata) ? out.metadata : {},
      })
      return Promise.resolve()
    },
    event(inputEvent) {
      const event = inputEvent.event as { type: string; properties: unknown }
      const props = obj(event.properties) ? event.properties : undefined
      if (!props) return Promise.resolve()

      if (event.type === "session.created" || event.type === "session.updated") {
        const sessionID = str(props.sessionID)
        const info = obj(props.info) ? props.info : undefined
        if (!sessionID || !info) return Promise.resolve()
        boot(sessionID, {
          title: str(info.title),
          directory: str(info.directory) ?? input.directory,
          worktree: input.worktree,
          parentID: str(info.parentID),
        })
        return Promise.resolve()
      }

      if (event.type === "message.updated") {
        const info = obj(props.info) ? props.info : undefined
        if (!info || str(info.role) !== "assistant") return Promise.resolve()
        const id = str(info.id)
        if (!id) return Promise.resolve()
        msgs.set(id, {
          agent: str(info.agent),
          model: {
            providerID: str(info.providerID) ?? "",
            modelID: str(info.modelID) ?? "",
          },
        })
        return Promise.resolve()
      }

      if (event.type === "message.part.updated") {
        const sessionID = str(props.sessionID)
        const next = obj(props.part) ? props.part : undefined
        if (!sessionID || !next) return Promise.resolve()
        const type = str(next.type)
        if (type !== "text" && type !== "reasoning") return Promise.resolve()
        const text = str(next.text)?.trim()
        const time = obj(next.time) ? next.time : undefined
        const end = num(time?.end)
        const partID = str(next.id)
        const messageID = str(next.messageID)
        if (!text || !end || !partID || !messageID || parts.has(partID)) return Promise.resolve()
        parts.add(partID)
        const msg = msgs.get(messageID)
        emit(sessionID, "assistant.message", {
          messageID,
          partID,
          partType: type,
          text,
          agent: msg?.agent,
          model: msg?.model?.providerID && msg.model.modelID ? msg.model : undefined,
        })
        return Promise.resolve()
      }

      if (event.type === "permission.asked") {
        const sessionID = str(props.sessionID)
        if (!sessionID) return Promise.resolve()
        boot(sessionID, {
          directory: input.directory,
          worktree: input.worktree,
        })
        const tool = obj(props.tool) ? props.tool : undefined
        emit(sessionID, "permission.asked", {
          requestID: str(props.id),
          permission: str(props.permission),
          patterns: Array.isArray(props.patterns) ? props.patterns : [],
          metadata: obj(props.metadata) ? props.metadata : {},
          tool: tool
            ? {
                messageID: str(tool.messageID),
                callID: str(tool.callID),
              }
            : undefined,
        })
        return Promise.resolve()
      }

      if (event.type === "permission.replied") {
        const sessionID = str(props.sessionID)
        if (!sessionID) return Promise.resolve()
        emit(sessionID, "permission.replied", {
          requestID: str(props.requestID),
          reply: str(props.reply),
        })
        return Promise.resolve()
      }

      return Promise.resolve()
    },
  }
}
