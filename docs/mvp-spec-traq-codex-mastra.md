あなたは、新しい TypeScript モノレポに対して、最小だが実際に動く MVP を実装するコーディングエージェントです。
目的は、traQ 上から 1 回のメッセージで Codex を起動し、Codex が Mastra の MCP ツールを使いながら処理を進め、途中経過ログをできるだけリアルタイムに traQ へ返し、最後に最終回答を traQ に返す一連の流れを成立させることです。

重要:
- 今回は「動くこと」を最優先にしてください。
- 過度な抽象化や将来対応のための複雑な基盤は作らないでください。
- ただし、後で拡張しやすい最低限の責務分離はしてください。
- 実行主体は Codex CLI です。Mastra は AI 本体ではなく、Codex から利用する MCP ツール群の提供側として使ってください。
- 新しい repo で実装してください。
- 参考実装として、途中で以下の repo を新しい repo 配下の参照ディレクトリに clone して読んでください。
  - https://github.com/pikachu0310/discord-codex-bot
- その repo のうち、Codex CLI 起動、JSONL/ストリーミング処理、セッションログ保存、作業ディレクトリ管理の考え方は参考にしてよいです。
- Discord 固有の UI や Deno 固有の構造は無理に持ち込まず、新 repo の設計に合わせて必要最小限だけ取り入れてください。

今回の MVP のゴール:
1. traQ から Bot を呼べる
2. Bot が Codex CLI を non-interactive に起動できる
3. Codex は Mastra の local stdio MCP ツールを使える
4. Codex の進捗をパースして traQ に逐次返せる
5. 最終回答を traQ に返せる
6. 少なくともローカル開発環境で、traQ 実運用または模擬イベントのどちらかで end-to-end を実際に動かして確認できる
7. README を読めば他者が再現できる

最重要の設計方針:
- シンプルなモノレポにしてください
- pnpm workspace を使ってください
- Node.js + TypeScript で統一してください
- DB や Redis やキュー基盤は入れないでください
- 永続化はまずローカルファイルで十分です
- k8s, Docker 本番構成, 認証基盤, 管理画面などは今回作らないでください
- ただし .env ベースの設定整理、ログ、最低限のエラーハンドリングは入れてください
- Mastra はまず MCP サーバー用途に絞ってください
- Codex の session id と traQ の会話/スレッドの対応付けはファイルに保存してください
- traQ の thread id を Codex の resume session id と同一視しないでください
- Codex への起動引数は、インストールされている CLI の実際の構文を確認してから合わせてください
- 目標動作は「resume 可能な non-interactive 実行」「JSON ストリーミング取得」です

実装してほしい最小アーキテクチャ:
- apps/traq-bot
  - traQ からの受信
  - traQ への送信
  - 進捗メッセージ更新または追記
  - ローカル開発用の模擬イベント実行導線
- apps/mastra-mcp
  - Codex から stdio で起動される Mastra MCP サーバー
  - 少なくとも 1 個以上の実用ツールを持つこと
  - 例:
    - demo service status を返す
    - ローカル JSON / Markdown / fixture を読む
    - 将来の内部サービス参照の雛形になるもの
- packages/codex-runner
  - Codex CLI の起動
  - stdout/stderr のストリーム処理
  - NDJSON の解析
  - session id の保存と resume
  - .codex/config.toml の生成または管理
- packages/shared
  - 型
  - イベント
  - 設定
  - 永続化ユーティリティ
- scripts または tools
  - ローカル E2E 実行用スクリプト
  - fixtures 作成スクリプトが必要ならそれも

repo の初期構造は、より良い簡略版があるなら変えてよいですが、少なくとも責務は上記に近づけてください。

まず最初にやること:
1. repo 全体の現状を確認
2. 参考 repo を以下に clone
   - _references/discord-codex-bot
3. 参考 repo のうち、以下の論点を確認
   - Codex CLI 起動
   - ストリーミング JSONL 解析
   - セッションログ保存
   - 作業ディレクトリ管理
4. そのうえで今回の MVP に不要なものを明確に切り捨ててください
5. 実装に入ってください

参考 repo から特に見てほしい観点:
- Worker 的な責務の切り方
- stream processor の作り方
- セッションログの保存
- 作業ディレクトリやセッションディレクトリの持ち方
- Bot 向けに進捗を逐次返す発想
ただし、今回の新 repo に Discord 専用コードや不要な周辺機能を持ち込まないでください。

Codex 実行に関する要件:
- 非対話モードで実行する
- follow-up を送れる構造にする
- session id を保存して resume できるようにする
- JSON ストリーミングを受けてイベント化する
- 今回はローカルサーバー上の isolated 環境で動かす想定
- runner は将来差し替えやすいように、CLI 呼び出し部分とイベント解釈部分を分ける
- ただし抽象化しすぎないこと

Mastra MCP に関する要件:
- local stdio 起動
- Codex プロジェクトローカル設定から使えるようにする
- 使うツールは allowlist 的に絞る
- 最低 1 つは Codex が本当に呼べることを end-to-end で確認する
- ツールは今後「traP 内部サービス参照」に育てやすい形を意識する
- ただし今回の MVP では demo/fake data でもよい
- tool 名、引数、返り値はわかりやすくする

traQ に関する要件:
- まずは本当に動く最短経路を優先
- 実環境で traQ token 等があるなら実 traQ で接続する
- もしこの環境で traQ 接続情報が不足する場合でも、real traQ adapter を実装した上で、ローカル模擬イベントモードを必ず作って end-to-end を体験可能にする
- 模擬モードでは、traQ から来たメッセージ相当の payload を投入し、traQ へ返す相当の処理をコンソールまたはローカル出力で観察できるようにする
- つまり「本番経路のコード」は必ず作るが、「この場で実際に検証した経路」は環境条件に応じて real か mock のどちらでもよい
- README には、どこまで real に確認できたかを正直に書くこと

途中経過ログの扱い:
- Codex の生イベントをそのまま全部垂れ流すのではなく、traQ に見せるのに適した粒度へ要約・整形してください
- ただし debugging 用には raw JSONL も保存してください
- 進捗メッセージの候補:
  - セッション開始
  - 計画更新
  - MCP tool 呼び出し開始/完了
  - 重要なコマンド実行
  - エラー
  - 最終回答
- 可能なら traQ 上の 1 メッセージ更新で進捗を見せ、難しければ複数メッセージ追記でもよい
- まずは実装容易性を優先してください

永続化の要件:
- file-based で十分
- 例:
  - data/conversations/{traq_thread_or_channel_key}.json
  - data/codex-sessions/{session_id}.jsonl
  - data/runtime/*.json
- 保存する最低限:
  - traQ 会話キー
  - Codex session id
  - 最終プロンプト
  - 実行時刻
  - raw JSONL ログのパス
- 再起動耐性は最低限でよいが、resume のための session mapping は残してください

開発・実行コマンドの要件:
- `pnpm install` で入る
- `pnpm dev` で必要なものが起動する、または明確な複数コマンドが README にある
- `pnpm test` または最低限の smoke test がある
- `pnpm demo` のようなコマンドで、模擬イベントによる end-to-end を再現できると嬉しい
- Codex/traQ/Mastra の各前提条件は README に明記してください

README に必ず書くこと:
- この MVP の目的
- 現在の構成
- 実装されている範囲
- 実 traQ を使う場合の設定
- mock モードの動かし方
- Codex CLI の前提
- Mastra MCP の接続方法
- どこに session mapping と raw logs が保存されるか
- 今後の拡張ポイント
- 未実装・割り切り事項

受け入れ条件:
- 新しい repo に必要な実装が入っている
- 参考 repo を clone して読み、必要な部分だけ参考にしている
- 少なくとも 1 個の Mastra MCP tool を Codex が実際に使う
- traQ からの入力→Codex→Mastra MCP→最終返答 の一連の流れが、real か mock のどちらかで実際に確認できる
- 進捗ログの中継が最低限動く
- session mapping が保存され、次回 resume の基盤がある
- README が整備されている
- 実装後、実際にコマンドを叩いて動作確認し、結果を要約して報告する

作業の進め方:
- まず小さく動く縦切りを作る
- その後に進捗表示や永続化を足す
- 迷ったら複雑な設計ではなく単純な設計を選ぶ
- わからない点は、まずリポジトリ内と公式ドキュメントで確認し、合理的な仮定を置いて前進する
- 不要な確認質問はしない
- 途中で設計が重くなりそうなら削る
- ただし「実際に end-to-end で動いた」というゴールは削らない

最後の出力では、必ず以下を含めてください:
1. 実装した構成の要約
2. 参考 repo から何を参考にしたか
3. 実際にどのコマンドで確認したか
4. real traQ で確認できたか、mock だったか
5. 未解決事項
6. 次にやると良いこと

では作業を開始してください。
