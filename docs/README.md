# wtx API ドキュメント

`@snomiao/wtx` と `@snomiao/wtx-react` が提供する API の一覧。

## パッケージ

| Package | 用途 | 詳細 |
|---|---|---|
| [`@snomiao/wtx`](./wtx.md) | Bun PTY WebSocket server + CLI | サーバー側、ターミナルセッション管理 |
| [`@snomiao/wtx-react`](./wtx-react.md) | xterm.js React component | クライアント側、ブラウザでターミナル UI |

## プロトコル

両者は WebSocket 経由で通信する。詳細は [protocol.md](./protocol.md)。

## 全体像

```
ブラウザ <--WS--> wtx server <--PTY--> shell (bash/zsh/...)
   |                |
   wtx-react       @snomiao/wtx
   (xterm.js)      (Bun.serve)
```

- 1セッション = 1 PTY プロセス + 1MB replay buffer
- 複数 WS クライアントが同じセッションに attach 可能（multi-tab）
- WS 切断後もセッションは生き続け、再接続で buffer を replay
- tmux 不要（xterm.js のネイティブ選択・スクロール・コピーが使える）

## API カテゴリ

### サーバーライブラリ（`@snomiao/wtx`）
- `startTerminalWS()` — WS サーバー起動
- `createSession()` — 名前付きセッション作成
- `hasSession()` — セッション存在確認
- `getTerminalStatusForRepo()` — repo 配下のセッション状態
- `getTermSummaryForCwd()` — ターミナル出力サマリ

### CLI（`@snomiao/wtx`）
- `wtx` — サーバーを起動するだけ（環境変数で挙動制御）

### HTTP エンドポイント（`@snomiao/wtx`）
- `GET /sessions` — 全セッション一覧
- `POST /sessions/:key` — 名前付きセッション作成
- `DELETE /sessions/:key` — セッション kill + 削除
- `GET /sessions/:key/buffer` — replay buffer 取得
- `GET /sessions/:key/git` — Git status
- `POST /sessions/:key/input` — PTY に入力送信
- `GET /summary?cwd=` — cwd 対応セッションのサマリ
- `GET /status/:owner/:repo` — repo 状態 (要 `WTX_REPO_BASE`)
- `WS /?cwd=...&cols=...&rows=...` — ターミナル接続

### 認証について
`TERMINAL_ACCESS_KEY` 環境変数が未設定の場合、**全エンドポイントが認証なしで開放** される（mutation 含む）。これは意図的な設計で、リバースプロキシ等の外部 auth gateway に認証を委譲する想定。本番デプロイ時はキー設定 or gateway での認証必須。

### React コンポーネント（`@snomiao/wtx-react`）
- `<WTx wsUrl cwd? session? onCwdChange? initialCmd? onActivity? darkTheme? lightTheme? className? />`
