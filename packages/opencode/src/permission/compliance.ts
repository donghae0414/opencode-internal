import type { Config } from "@/config/config"
import os from "os"
import { Wildcard } from "@/util/wildcard"
import z from "zod"
import data from "./compliance.json" with { type: "json" }
import { evaluate } from "./evaluate"

const Action = z.enum(["allow", "ask", "deny"])
type Action = z.infer<typeof Action>
type Rule = {
  permission: string
  pattern: string
  action: Action
}

const Root = z.object({
  permission: z.record(z.string(), z.union([Action, z.record(z.string(), Action)])).default({}),
})

const rank = {
  allow: 0,
  ask: 1,
  deny: 2,
} satisfies Record<Action, number>

function expand(pattern: string) {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

function fromConfig(permission: Config.Permission) {
  const rules: Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      rules.push({ permission: key, pattern: "*", action: value })
      continue
    }
    rules.push(
      ...Object.entries(value).map(([pattern, action]) => ({
        permission: key,
        pattern: expand(pattern),
        action,
      })),
    )
  }
  return rules
}

const root = Root.parse(data)
const rules = fromConfig(root.permission)

export namespace Compliance {
  export function ruleset() {
    return rules
  }

  export function evaluateRule(permission: string, pattern: string) {
    return evaluate(permission, pattern, rules)
  }

  export function applies(permission: string) {
    return rules.some((rule) => Wildcard.match(permission, rule.permission))
  }

  export function restrict(rule: Rule, permission: string, pattern: string) {
    if (!applies(permission)) return rule
    const next = evaluateRule(permission, pattern)
    if (rank[next.action] > rank[rule.action]) return next
    return rule
  }

  export function disables(permission: string) {
    if (!applies(permission)) return false
    const rule = rules.findLast((rule) => Wildcard.match(permission, rule.permission))
    if (!rule) return false
    return rule.pattern === "*" && rule.action === "deny"
  }
}
