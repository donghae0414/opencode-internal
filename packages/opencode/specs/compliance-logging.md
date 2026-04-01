# Compliance logging

OpenCode 포크에 추가한 session 단위 compliance logging의 배경, 설계 이유, 구현 범위, 유지보수 포인트를 정리한 문서다.

이 문서는 **Phase 1 구현 기준**이다.

## 목표

사내 배포용 OpenCode 바이너리에서 아래 이력을 session 단위 파일로 남긴다.

- 사용자 입력 메시지
- assistant 출력 메시지
- tool 호출 요청
- tool 출력
- 사용자 승인/거부 이력
- 사고 추적에 필요한 최소 session 메타데이터

로그 경로는 실행 중인 작업 디렉토리 기준으로 다음을 사용한다.

- `<running directory>/.opencode/compliance-log/<session-id>.jsonl`

## 왜 이렇게 설계했는가

### 1. upstream merge 비용을 최소화하려고

이 저장소는 upstream release 반영 속도가 중요하다. 그래서 `session/prompt.ts`, `session/processor.ts`, `permission/index.ts` 같은 hot path에 compliance 전용 로직을 퍼뜨리지 않고, 기존 plugin hook / bus event fanout을 재사용하는 방향을 선택했다.

핵심 원칙은 다음 두 가지다.

- 새 파일 추가를 우선한다.
- 기존 파일 수정은 중앙 registration 포인트로 제한한다.

결과적으로 production code에서 의도적으로 수정한 기존 파일은 아래 두 곳이다.

- `packages/opencode/src/plugin/index.ts`
- `.gitignore`

### 2. 기존 저장 구조를 대체하지 않고 보완하려고

이미 SQLite에는 session/message/part 데이터가 저장된다. 하지만 보안팀 요구는 **session별 파일 로그**다. 따라서 기존 DB를 바꾸지 않고, 별도의 append-only JSONL 파일을 추가했다.

이렇게 하면:

- 기존 session/message 기능을 건드리지 않는다.
- export/DB schema migration 없이 도입 가능하다.
- 운영 중 장애가 나도 로그 파일을 바로 확보할 수 있다.

### 3. compliance plugin은 기본적으로 항상 켜져 있어야 해서

이번 기능은 “optional plugin”이 아니라 사내 compliance 요구를 강제하는 기능이다. 따라서 built-in plugin으로 등록했다.

현재 구현은 `packages/opencode/src/plugin/index.ts`의 `INTERNAL_PLUGINS`에 추가하는 방식이다. 이 plugin은 배포 바이너리에 기본 포함되며, 유지보수 시에도 **임의로 disable되는 방향으로 바꾸지 않는 것**이 기본 정책이다.

## 구현 위치

### production

- `packages/opencode/src/compliance/writer.ts`
- `packages/opencode/src/compliance/plugin.ts`
- `packages/opencode/src/plugin/index.ts`

### test

- `packages/opencode/test/compliance/writer.test.ts`
- `packages/opencode/test/compliance/plugin.test.ts`

## 구성 요소

## `writer.ts`

역할:

- session별 JSONL 파일 경로 계산
- 로그 디렉토리 생성
- 한 줄씩 append
- 파일 권한 `0600` 설정

주요 함수:

- `file(dir, sessionID)`
  - 최종 JSONL 파일 경로 반환
- `write(dir, sessionID, item)`
  - JSON 직렬화 후 newline을 붙여 append

설계 이유:

- 구현을 아주 작게 유지하기 위해 sync append를 사용했다.
- event fanout 경로가 sync라서, event 훅에서 write가 실제로 실행되도록 하려면 Phase 1에서는 sync write가 가장 단순하고 안전하다.

주의:

- 대용량 output이 많아지면 파일이 빨리 커질 수 있다.
- rotation / retention은 Phase 1 비범위다.

## `plugin.ts`

역할:

- 기존 plugin hook / bus event를 받아 compliance JSONL 레코드로 변환

내부 상태:

- `meta: Set<string>`
  - session별 `session.meta`를 한 번만 기록하기 위한 dedupe
- `parts: Set<string>`
  - 같은 assistant part를 중복 기록하지 않기 위한 dedupe
- `msgs: Map<string, { agent?, model? }>`
  - `message.updated`에서 assistant message 메타를 캐시해 두었다가, 이후 `message.part.updated` 기록 시 보강

## 어떤 이벤트를 어떻게 기록하는가

### 1. `chat.message`

기록 타입:

- `session.meta` (session당 최초 1회)
- `user.message`

기록 이유:

- 사용자 입력 prompt는 hook 시점에서 가장 자연스럽게 확보된다.
- persistence 직전의 normalized user parts를 그대로 남길 수 있다.

### 2. `tool.execute.before`

기록 타입:

- `tool.call.request`

포함 정보:

- `tool`
- `callID`
- `args`

기록 이유:

- native tool 호출 입력을 직접 잡을 수 있다.
- callID로 이후 output과 매칭 가능하다.

### 3. `tool.execute.after`

기록 타입:

- `tool.call.output`

포함 정보:

- `tool`
- `callID`
- `args`
- `title`
- `output`
- `metadata`

기록 이유:

- Phase 1 요구에서 tool output은 현재 native hook이 주는 output이면 충분하다고 합의되었다.

주의:

- 이것은 “최종 원시 stdout/stderr 전체” 보장을 뜻하지는 않는다.
- hook이 노출하는 output을 남기는 것이 현재 구현 범위다.

### 4. `event` 훅

기록 대상:

- `session.created`
- `session.updated`
- `message.updated`
- `message.part.updated`
- `permission.asked`
- `permission.replied`

#### `session.created` / `session.updated`

기록 타입:

- `session.meta` (없을 때만)

포함 정보:

- `title`
- `directory`
- `worktree`
- `parentID`

설계 이유:

- session 메타는 가능하면 session 이벤트에서 가져오는 것이 가장 정확하다.
- 다만 항상 먼저 오지 않을 수도 있어 `chat.message` 경로에도 fallback을 둔다.

#### `message.updated`

기록 자체는 하지 않고, assistant message 메타를 캐시한다.

캐시 목적:

- 이후 `message.part.updated`가 왔을 때 `agent`, `providerID`, `modelID`를 함께 기록하기 위해서다.

#### `message.part.updated`

기록 타입:

- `assistant.message`

필터 조건:

- `part.type === "text" || part.type === "reasoning"`
- `part.time.end`가 있어야 함
- `text`가 비어 있지 않아야 함
- `partID` 중복 기록 금지

중요한 설계 선택:

- assistant 출력은 **turn 전체 blob**이 아니라 **완료된 text/reasoning part 단위**로 기록한다.
- 이유는 hot path를 더 건드리지 않고, existing event만으로 가장 안정적으로 구현할 수 있기 때문이다.

의미:

- 감사 도구가 later phase에서 turn 단위 재조합을 하고 싶다면 별도 aggregation을 추가할 수 있다.
- 하지만 Phase 1에서는 part 단위 기록이 가장 작은 변경이다.

#### `permission.asked`

기록 타입:

- `permission.asked`

포함 정보:

- `requestID`
- `permission`
- `patterns`
- `metadata`
- `tool` (`messageID`, `callID`) if present

#### `permission.replied`

기록 타입:

- `permission.replied`

포함 정보:

- `requestID`
- `reply`

설계 이유:

- 승인/거부 이력은 DB 기반 session export만으로는 충분히 남지 않으므로 별도 파일 로그가 꼭 필요했다.

## JSONL 레코드 형식

모든 레코드는 공통 envelope을 가진다.

```json
{
  "v": 1,
  "ts": "2026-04-01T04:00:00.000Z",
  "sessionID": "ses_xxx",
  "type": "user.message",
  "data": {}
}
```

### 현재 사용하는 `type`

- `session.meta`
- `user.message`
- `assistant.message`
- `tool.call.request`
- `tool.call.output`
- `permission.asked`
- `permission.replied`

## 유지보수 포인트

### 1. event 훅은 사실상 sync 제약이 있다

`packages/opencode/src/plugin/index.ts`의 bus fanout은 sync 문맥에서 hook을 호출한다. 따라서 compliance plugin의 event 처리도 Phase 1에서는 sync-safe해야 한다.

현재 구현이 sync append를 사용하는 이유가 이것이다.

만약 나중에 async writer로 바꾸고 싶다면 다음 중 하나가 필요하다.

- 내부 queue + flush worker
- fire-and-forget가 허용되는 별도 durability 전략

그냥 `await fs.promises.appendFile(...)` 같은 식으로 바꾸면 event fanout 기대와 어긋날 수 있다.

### 2. `assistant.message`는 part 단위다

현재 레코드는 assistant turn 전체를 합친 결과가 아니다.

즉 한 turn에서:

- 여러 text part
- reasoning part

가 있으면 여러 줄이 생길 수 있다.

이건 의도된 trade-off다.

- 장점: 구현 단순, 기존 이벤트와 잘 맞음
- 단점: 사람이 읽는 transcript와 1:1로 같지는 않음

### 3. session meta는 첫 관측 시점 기준이다

`session.meta`는 session당 한 번만 기록된다.

따라서 session title 같은 값이 나중에 바뀌어도 현재 Phase 1 구현은 첫 snapshot만 남긴다. 이것도 의도된 단순화다.

만약 title 변경 이력까지 필요해지면 별도 `session.updated` 레코드 타입을 추가해야 한다.

### 4. redaction은 아직 없다

현재는 입력/출력/metadata를 그대로 기록한다.

따라서:

- 민감값 마스킹
- credential redaction
- structured filtering

은 아직 없다. 운영 환경에서 더 강한 요구가 생기면 writer 앞단에 redaction 계층을 두는 것이 가장 자연스럽다.

### 5. compliance plugin은 built-in이다

유지보수 시 주의할 점:

- 이 기능은 optional plugin처럼 취급하지 않는다.
- 향후 built-in plugin disable 정책을 추가하더라도, compliance plugin이 빠지면 안 되는지 먼저 확인해야 한다.

즉 “default plugin disable”과 “mandatory compliance plugin”은 같은 개념이 아니다.

## 테스트

추가된 테스트:

- `packages/opencode/test/compliance/writer.test.ts`
- `packages/opencode/test/compliance/plugin.test.ts`

검증한 항목:

- writer가 디렉토리를 만들고 JSONL을 append하는지
- `chat.message`에서 `session.meta`, `user.message`가 기록되는지
- native tool request/output이 기록되는지
- `permission.asked`, `permission.replied`가 기록되는지
- 완료된 assistant text part가 `assistant.message`로 기록되는지

추가 회귀 검증으로 함께 확인한 것:

- `test/plugin/trigger.test.ts`
- `test/permission/next.test.ts`
- `test/question/question.test.ts`
- `bun typecheck`
- `bun run build`

## Phase 1 비범위

이번 구현에서 일부러 하지 않은 것:

- exact outbound LLM payload 기록
- system prompt 기록
- question tool 감사 로그
- redaction / masking
- retention / rotation
- tamper-evident hash chain
- remote shipping (SIEM, object storage 등)
- assistant turn-level aggregation

## 나중에 확장할 때 추천 순서

필요 시 다음 순서가 유지보수 비용 대비 효율이 좋다.

1. `session.updated`/`question.*` 레코드 추가
2. redaction 계층 추가
3. retention / rotation 추가
4. assistant turn aggregation 추가
5. exact outbound payload 기록 추가
6. tamper-evident / remote shipping 추가

## 요약

이번 구현은 “기존 runtime을 최대한 활용해서 session별 compliance 파일 로그를 남긴다”는 목표에 맞춘 **작은 built-in plugin 설계**다.

핵심은 다음이다.

- 기존 hot path를 거의 안 건드린다.
- plugin hook + bus event만으로 Must 요구를 충족한다.
- 기록 형식은 단순한 JSONL이다.
- assistant 출력은 part 단위라는 점이 가장 중요한 유지보수 포인트다.
