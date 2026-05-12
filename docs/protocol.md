# WebSocket プロトコル

`@snomiao/wtx` サーバーと `@snomiao/wtx-react`（または任意のクライアント）の通信仕様。

## エンドポイント

```
ws://host:3004/?cwd=<path>&cols=<n>&rows=<n>&session=<name>&key=<accessKey>
```

### クエリパラメータ

| パラメータ | 必須 | デフォルト | 用途 |
|---|---|---|---|
| `cwd` | `session` 未指定時のみ | – | 新規セッションの cwd |
| `cols` | – | 80 | 初期列数（最小 10） |
| `rows` | – | 24 | 初期行数（最小 2） |
| `session` | – | – | 既存セッションに attach |
| `key` | 非ローカル接続時 | – | アクセスキー（ヘッダでも可） |

### 認証

`TERMINAL_ACCESS_KEY` 環境変数が設定されており、かつクライアントが非ローカル（`127.0.0.1` / `::1` 以外）なら、以下のいずれかが必要:

- ヘッダ: `Authorization: Bearer <KEY>`
- クエリ: `?key=<KEY>`

不一致なら HTTP 401。

## 接続確立後のフロー

### サーバー → クライアント

1. **Replay buffer**: 既存セッションの buffer 全 chunk を順次送信（バイナリ）
2. **継続出力**: PTY から出力されるバイトをそのまま送信（バイナリ）

### クライアント → サーバー

#### バイナリメッセージ
PTY の stdin にそのまま書き込まれる（生バイト）。

#### 文字列メッセージ（JSON 制御）
`JSON.parse()` でパースされ、以下の `type` で分岐:

##### `resize`
ターミナルサイズを変更する。
```json
{ "type": "resize", "cols": 120, "rows": 30 }
```

##### `ping`
heartbeat。サーバーは `pong` を返す。
```json
{ "type": "ping", "t": 1715500000000 }
```
レスポンス:
```json
{ "type": "pong", "t": 1715500000000 }
```

JSON でない文字列は stdin として PTY に書き込まれる。

### 特殊なサーバーメッセージ

#### `cwd` 通知（OSC 7 検出時）
シェルが OSC 7 シーケンス（`ESC ] 7 ; file://host/path ESC \`）を出力すると、サーバーが解析して JSON でクライアントに送信する:
```json
{ "type": "cwd", "path": "/new/cwd" }
```

#### `[session ended]` (PTY 終了時)
PTY プロセスが終了すると、サーバーが以下のバイト列を全クライアントに送信:
```
\r\n\x1b[33m[session ended]\x1b[0m\r\n
```
（黄色文字で `[session ended]`）

## サーバー側の自動応答

PTY 出力中の特定 VT クエリに対し、サーバーが xterm.js を待たずに直接 PTY に応答する。バックグラウンドタブでクライアントが応答できない場合のブロック回避策。

| クエリ | サーバー応答 |
|---|---|
| `ESC[c` / `ESC[0c` (Device Attributes) | `ESC[?1;2c` (VT100+AVO) |
| `ESC[6n` (Cursor Position Report) | `ESC[1;1R` (row 1, col 1) |

## クローズ動作

- クライアント `ws.close()` → サーバーは PTY を **kill しない**。セッションは生存し、再接続可能
- PTY 自然終了 → サーバーは `[session ended]` 送信、`_exited` マーク
  - `cwd` セッションへの新規 attach → 新シェルで置換
  - `session` セッションへの attach → buffer のみ閲覧可能

## エラー応答

| 状況 | 動作 |
|---|---|
| `cwd` 不正 / 未指定（session 指定なし） | エラーメッセージ送信 + `close(1008, msg)` |
| `session` 指定したが存在せず | `\x1b[31msession "X" not found\x1b[0m\r\n` 送信 + `close(1008)` |
| アクセスキー不一致 | HTTP 401 (WS upgrade 前) |

## バッファ仕様

- セッションごとに **1 MB** の replay buffer
- PTY 出力を全て蓄積、上限超過時は古い chunk から FIFO で破棄
- 新規 attach 時に buffer 全体を順次送信
- バックプレッシャー検出時（`ws.send()` が `< 0`）はその chunk をスキップ（クライアントが追いつき次第 buffer replay で復旧）

## クライアント実装の最小例

```ts
const ws = new WebSocket(`ws://localhost:3004/?cwd=${encodeURIComponent(cwd)}&cols=80&rows=24`);
ws.binaryType = "arraybuffer";

ws.onmessage = (e) => {
  if (typeof e.data === "string") {
    const msg = JSON.parse(e.data);
    if (msg.type === "cwd") console.log("cwd changed:", msg.path);
    if (msg.type === "pong") console.log("rtt:", Date.now() - msg.t);
    return;
  }
  // バイナリは PTY 出力（ターミナルに書き込む）
  terminal.write(new Uint8Array(e.data));
};

// stdin 送信
ws.send(new TextEncoder().encode("ls\r"));

// リサイズ
ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));

// heartbeat
setInterval(() => ws.send(JSON.stringify({ type: "ping", t: Date.now() })), 10000);
```
