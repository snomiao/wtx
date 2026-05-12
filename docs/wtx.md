# @snomiao/wtx

Bun PTY WebSocket server with replay buffer + tmux-free session management.

## インストール

```sh
bun add @snomiao/wtx
```

## CLI

```sh
bunx @snomiao/wtx
```

サーバーを起動する。引数なし。設定は環境変数で行う。

## 環境変数

| 変数 | デフォルト | 用途 |
|---|---|---|
| `TERMINAL_WS_PORT` | `3004` | WS サーバーのポート番号 |
| `TERMINAL_ACCESS_KEY` | 空 | 非ループバック接続のアクセスキー。空ならローカル接続のみ許可 |
| `WTX_DEFAULT_CWD` | `process.cwd()` | 新規セッションの fallback cwd |
| `WTX_REPO_BASE` | 空 | `/status/:owner/:repo` を有効化するベースディレクトリ。例: `/home/user/code` |
| `SHELL` | `bash` | 新規セッションで起動するシェル |

### アクセスキーの渡し方

非ローカルから接続する場合は以下のいずれかで `TERMINAL_ACCESS_KEY` を渡す:

- HTTP ヘッダ: `Authorization: Bearer <KEY>`
- URL クエリ: `?key=<KEY>`

ローカル接続（`127.0.0.1` / `::1`）はキーをスキップする。

## ライブラリ API

```ts
import {
  startTerminalWS,
  createSession,
  hasSession,
  getTerminalStatusForRepo,
  getTermSummaryForCwd,
} from "@snomiao/wtx";
```

### `startTerminalWS(): Bun.Server`

WS サーバーを起動する。`TERMINAL_WS_PORT` で待ち受け、HTTP API と WebSocket の両方を提供する。

```ts
startTerminalWS();
```

戻り値は `Bun.serve()` の Server オブジェクト。

### `createSession(sessionKey, cmd, cols, rows, cwd, onExit?): Session`

名前付き PTY セッションを作成または置換する。

| 引数 | 型 | 用途 |
|---|---|---|
| `sessionKey` | `string` | セッション識別子（例: `"agent-123"`） |
| `cmd` | `string[]` | 実行するコマンドと引数（例: `["bash", "-l"]`） |
| `cols` | `number` | 初期列数 |
| `rows` | `number` | 初期行数 |
| `cwd` | `string` | 作業ディレクトリ |
| `onExit` | `() => void` | PTY 終了時のコールバック |

同名セッションがあれば kill して置き換える。WS クライアントから `?session=<sessionKey>` で attach できる。

### `hasSession(sessionKey: string): boolean`

セッションが存在するか確認する。

### `getTerminalStatusForRepo(repoFolder: string)`

repo フォルダ配下のセッションを 1 件探して状態を返す。

```ts
{
  status: "active" | "idle" | "closed";   // 60秒以内に活動があれば active
  lastActivity: number | null;            // ms timestamp
  cwd: string | null;                     // 一致したセッションの cwd
}
```

### `getTermSummaryForCwd(cwd: string)`

cwd 配下のセッションのターミナル出力をレンダリングしてサマリを返す。`term-summary.ts` の `summarizeTerminal()` で生成。

## HTTP エンドポイント

### `GET /sessions`

全セッションの一覧を JSON で返す。

```json
[
  {
    "key": "agent-1",
    "cwd": "/path/to/repo",
    "cmd": ["bash"],
    "cols": 80,
    "rows": 24,
    "clients": 1,
    "bufferBytes": 12345,
    "startedAt": 1715500000000,
    "lastActivity": 1715500001234,
    "exited": false
  }
]
```

### `GET /sessions/:key/buffer`

セッションの replay buffer を取得する。

クエリ:
| パラメータ | 用途 |
|---|---|
| `strip=1` | ANSI エスケープを除去してプレーンテキストで返す |
| `tail=N` | 末尾 N 行のみ（strip 自動有効） |
| `offset=N` | 末尾 tail+offset の位置から tail 行 |

`strip` / `tail` / `offset` を指定すると `@xterm/headless` でレンダリングしてからテキスト化する（カーソル移動・上書きを反映した最終状態）。指定なしは生バイト列。

戻り値: `text/plain` (strip 系) または `application/octet-stream` (生)。

### `GET /sessions/:key/git`

セッションの cwd で `git status` 系コマンドを実行して結果を返す。

```json
{
  "branch": "main",
  "staged": 0,
  "unstaged": 2,
  "untracked": 1,
  "ahead": 0,
  "behind": 0
}
```

### `POST /sessions/:key/input`

セッションの PTY に入力を書き込む。body は raw bytes。

クエリ `?cr=1` で末尾に `\r` を追加（コマンド実行を意図する場合）。

```sh
curl -X POST "http://localhost:3004/sessions/agent-1/input?cr=1" \
  --data-binary "ls -la"
```

### `GET /summary?cwd=<path>`

`getTermSummaryForCwd(cwd)` の HTTP 版。

### `GET /status/:owner/:repo`

`WTX_REPO_BASE` 配下の `<owner>/<repo>` セッションの状態を返す。`WTX_REPO_BASE` 未設定なら 404。

`getTerminalStatusForRepo()` の HTTP 版。

## WebSocket エンドポイント

```
ws://host:3004/?cwd=<path>&cols=<n>&rows=<n>&session=<name>
```

| パラメータ | 用途 |
|---|---|
| `cwd` | 作業ディレクトリ。新規セッション作成時に必須 |
| `cols` | 初期列数（最小 10） |
| `rows` | 初期行数（最小 2） |
| `session` | 既存の名前付きセッションに attach（cwd 不要） |

詳細プロトコルは [protocol.md](./protocol.md) を参照。

## セッションのライフサイクル

1. 接続: `?cwd=...` で新規 or `?session=...` で attach
2. attach 時: replay buffer を一括送信
3. メッセージ: バイナリ = stdin、JSON = 制御メッセージ
4. PTY 出力: 全 attach クライアントにブロードキャスト
5. 切断: PTY は生存、別 WS で再接続可能（buffer から再生）
6. PTY 終了: `[session ended]` 通知を全クライアントに送信、`_exited` マーク
7. cwd セッションで `_exited` 状態への再接続: 新しいシェルで置換
8. 名前付きセッションで `_exited` 状態への再接続: buffer のみ表示

## バッファ仕様

- 上限 **1 MB** (`MAX_BUFFER_BYTES`)
- 超過すると先頭 chunk から FIFO で破棄
- 再接続クライアントには現在の buffer 全てを replay
