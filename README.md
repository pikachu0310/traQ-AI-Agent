# traQ + Codex + Mastra MVP

traQ からの 1 メッセージを起点に、以下を実際に通すための最小 MVP です。

1. traQ メッセージ受信
2. Codex CLI を non-interactive で起動
3. Codex が Mastra の local stdio MCP ツールを呼び出し
4. 進捗を traQ 側へ中継
5. 最終回答を traQ 側へ返却

今回は「動くこと」を優先し、Node.js + TypeScript + pnpm workspace + file-based persistence で実装しています。

## 構成

```text
apps/
  traq-bot/       # traQ real/mock adapter + オーケストレーション
  mastra-mcp/     # Mastra MCP server (stdio)
packages/
  codex-runner/   # Codex CLI 実行、JSONL 解析、resume、raw log 保存
  shared/         # 型、設定、file persistence
docs/
  mvp-spec-traq-codex-mastra.md
_references/
  discord-codex-bot/   # 参考実装 clone
data/             # 会話マッピングと JSONL ログの保存先
```

## 実装範囲

- `apps/traq-bot`
  - `real` モード: `traq-bot-ts` WebSocket 受信 + traQ REST 送信
  - `mock` モード: ローカル擬似イベント投入とコンソール出力
  - 進捗中継: セッション開始 / MCP ツール開始・完了 / コマンド / エラー / 最終回答
- `apps/mastra-mcp`
  - local stdio MCP サーバー
  - 提供ツール
    - `get_demo_service_status`
    - `read_fixture_markdown`
- `packages/codex-runner`
  - `codex exec --json` / `codex exec ... resume <session>` の起動
  - JSONL ストリーム解析とイベント化
  - `thread.started` から session id 抽出
  - `data/conversations/*.json` に session mapping 保存
  - `data/codex-sessions/**/*.jsonl` に raw JSONL 保存
  - `data/runtime/codex-home/config.toml` を自動生成して MCP サーバーを接続

## 前提条件

- Node.js 22 以上
- Corepack 有効 (`corepack`)
- Codex CLI が利用可能であること (`codex --help`)
- Codex 認証済み (`~/.codex/auth.json` が存在)
- (real traQ の場合) Bot token

## セットアップ

```bash
cp .env.example .env
corepack pnpm install
```

## Mock での E2E 実行

```bash
corepack pnpm demo
```

期待される進捗ログ例:

- `MCP 呼び出し開始: mastra_local/get_demo_service_status`
- `MCP 呼び出し完了: ... (completed)`
- `最終回答: ...`

## Real traQ での実行

`.env` の最低限:

```env
BOT_MODE=real
TRAQ_BOT_TOKEN=xxxxxxxx
TRAQ_WS_URL=wss://q.trap.jp/api/v3/bots/ws
TRAQ_API_BASE_URL=https://q.trap.jp/api/v3
# 可能なら設定（自己送信無視の精度向上）
TRAQ_BOT_USER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

起動:

```bash
corepack pnpm dev
```

traQ で `BOT_TRIGGER_PREFIX`（デフォルト `/codex`）付きメッセージを送ると処理します。

## Codex / Mastra 接続

- Codex は `CODEX_HOME=data/runtime/codex-home` を使って起動
- `data/runtime/codex-home/config.toml` に `mcp_servers.mastra_local` を生成
- デフォルト起動コマンド:
  - `node --import tsx apps/mastra-mcp/src/index.ts`

## 永続化ファイル

- 会話マッピング:
  - `data/conversations/{conversation_key}.json`
- Codex raw JSONL:
  - `data/codex-sessions/{conversation_key}/{timestamp}_{session_id}.jsonl`
- Codex ローカル設定/実行状態:
  - `data/runtime/codex-home/*`

## 参考実装から流用した考え方

`_references/discord-codex-bot` から主に以下を流用:

- Codex CLI の non-interactive 実行
- JSONL ストリーム解析
- session id 抽出と保存
- raw セッションログ保存
- Bot 側への進捗中継

切り捨てたもの:

- Discord 固有 UI / Deno 固有構成
- 管理機能、複雑な運用機能、キューや重い基盤

## 割り切り / 未実装

- traQ メッセージ編集による進捗更新は未実装（現状は追記送信）
- 同時実行制御・ジョブキューは未実装
- 本番運用向け監視/認証強化は未実装

## 今後の拡張ポイント

1. 進捗を 1 メッセージ更新方式へ変更
2. traQ thread 連携の強化（threadId 取得の最適化）
3. Mastra ツールを内部サービス API 参照へ拡張
4. retry/backoff と実行キューの導入
