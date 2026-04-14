# traQ + Codex + MCP MVP

traQ からの 1 メッセージを起点に、以下を通す最小 MVP です。

1. traQ メッセージ受信
2. Codex CLI を non-interactive で起動
3. Codex が MCP ツールを呼び出し
4. 進捗を traQ 側へ中継
5. 最終回答を traQ 側へ返却

今回の追加で、`traQ OpenAPI` を使う専用 MCP サーバー (`apps/traq-mcp`) を実装しました。  
Codex から `operationId` 単位で traQ API を呼べます。

## 構成

```text
apps/
  traq-bot/       # traQ real/mock adapter + オーケストレーション
  mastra-mcp/     # ローカル fixture 用 MCP server (stdio)
  traq-mcp/       # traQ OpenAPI 連携 MCP server (stdio)
packages/
  codex-runner/   # Codex CLI 実行、JSONL 解析、resume、raw log 保存
  shared/         # 型、設定、file persistence
docs/
  mvp-spec-traq-codex-mastra.md
_references/
  discord-codex-bot/
data/
```

## 実装範囲

- `apps/traq-bot`
  - `real` モード: `traq-bot-ts` WebSocket 受信 + traQ REST 送信
  - `mock` モード: ローカル擬似イベント投入とコンソール出力
  - 進捗中継: セッション開始 / MCP ツール開始・完了 / コマンド / エラー / 最終回答
- `apps/mastra-mcp`
  - `get_demo_service_status`
  - `read_fixture_markdown`
- `apps/traq-mcp`
  - OpenAPI 取得元: `https://raw.githubusercontent.com/traPtitech/traQ/master/docs/v3-api.yaml`
  - `list_traq_operations`
  - `describe_traq_operation`
  - `call_traq_operation`
- `packages/codex-runner`
  - `codex exec --json` / `resume`
  - JSONL ストリーム解析とイベント化
  - `data/conversations/*.json` に session mapping 保存
  - `data/codex-sessions/**/*.jsonl` に raw JSONL 保存
  - `data/runtime/codex-home/config.toml` に複数 MCP サーバー定義を自動生成

## 前提条件

- Node.js 22 以上
- Corepack 有効 (`corepack`)
- Codex CLI が利用可能 (`codex --help`)
- Codex 認証済み (`~/.codex/auth.json`)
- traQ API 実行には `TRAQ_BOT_TOKEN`

## セットアップ

```bash
cp .env.example .env
corepack pnpm install
```

## Mock での E2E 実行

```bash
corepack pnpm demo
```

## Real traQ での実行

`.env` の最低限:

```env
BOT_MODE=real
TRAQ_BOT_TOKEN=xxxxxxxx
TRAQ_WS_URL=wss://q.trap.jp/api/v3/bots/ws
TRAQ_API_BASE_URL=https://q.trap.jp/api/v3
TRAQ_BOT_USER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

起動:

```bash
corepack pnpm dev
```

## MCP 設定

Codex は `CODEX_HOME=data/runtime/codex-home` で起動し、`config.toml` に `mcp_servers.*` を生成します。

- 既定:
  - `mastra_local`（常時）
  - `traq_api`（`TRAQ_BOT_TOKEN` がある場合）
- 明示的 override:
  - `MCP_SERVERS_JSON` に JSON 配列で複数サーバーを指定

`.env.example` に `TRAQ_MCP_*` / `MCP_SERVERS_JSON` の設定例を記載しています。

## traQ API を呼ぶときの基本フロー

1. `list_traq_operations` で候補の `operationId` を探す
2. `describe_traq_operation` で必要な path/query/body を確認する
3. `call_traq_operation` で実行する

`call_traq_operation` は `dryRun=true` でリクエスト内容だけ確認できます。

## 永続化ファイル

- 会話マッピング:
  - `data/conversations/{conversation_key}.json`
- Codex raw JSONL:
  - `data/codex-sessions/{conversation_key}/{timestamp}_{session_id}.jsonl`
- Codex ローカル設定:
  - `data/runtime/codex-home/*`

## 拡張方針（複数サービス対応）

今回の構成は「サービスごとに MCP サーバーを足し、Codex 側では `mcp_servers` を増やす」形です。

1. 別サービスの OpenAPI MCP サーバーを `apps/<service>-mcp` として追加
2. `MCP_SERVERS_JSON` へ登録
3. Bot 側プロンプトに利用方針を追記

この手順で traQ 以外にも水平展開できます。

## 参考実装から流用した考え方

`_references/discord-codex-bot` から主に流用:

- Codex CLI の non-interactive 実行
- JSONL ストリーム解析
- session id 抽出と保存
- raw セッションログ保存
- Bot 側への進捗中継

## 割り切り / 未実装

- traQ メッセージ編集による進捗更新は未実装（追記送信）
- 同時実行制御・ジョブキューは未実装
- 本番運用向け監視/認証強化は未実装
