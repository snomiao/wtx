# @snomiao/wtx-react

xterm.js ベースの React ターミナルコンポーネント。`@snomiao/wtx` サーバーと組み合わせて使う。

## インストール

```sh
bun add @snomiao/wtx-react react
```

`react >=18 <20` が peer dependency。

## 基本的な使い方

```tsx
import { WTx } from "@snomiao/wtx-react";

export function Terminal() {
  return (
    <WTx
      wsUrl="ws://localhost:3004"
      cwd="/path/to/workspace"
    />
  );
}
```

## Props（`WTxProps`）

| Prop | 型 | 必須 | 用途 |
|---|---|---|---|
| `wsUrl` | `string` | ✓ | WebSocket URL（フル or パス、例: `ws://host:3004` / `/api/terminal`） |
| `cwd` | `string` | – | 作業ディレクトリ。新規セッションで起動するシェルの cwd |
| `session` | `string` | – | 既存の名前付きセッション（例: `"agent-123"`）に attach |
| `onCwdChange` | `(cwd: string) => void` | – | シェルが cd した時に呼ばれる（OSC 7 を解析） |
| `initialCmd` | `string` | – | 接続確立後に PTY に送る初期コマンド |
| `onActivity` | `() => void` | – | サーバーから出力を受けるたびに呼ばれる |
| `darkTheme` | `ITheme` | – | ダークテーマ override（xterm.js の Theme 型） |
| `lightTheme` | `ITheme` | – | ライトテーマ override |
| `className` | `string` | – | ラッパー div の className（デフォルトはコンテナいっぱい） |

## デフォルトテーマ

- **Light**: VS Code "Light Modern"（背景 `#ffffff`, 前景 `#3b3b3b`）
- **Dark**: VS Code "Dark Modern"（背景 `#1f1f1f`, 前景 `#cccccc`）
- システムの `prefers-color-scheme` を監視して自動切替

## 機能

- VS Code Light/Dark Modern テーマ + システム自動切替
- OSC 11 背景色クエリ応答（シェル側プログラムが現在のテーマを検出可能）
- VT テーマ変更通知 `CSI ? 997 ; 1/2 h`（システムテーマ切替時）
- CJK 全角文字対応（`Unicode11Addon`）
- URL の自動リンク化（折り返し URL の復元込み）
- DOM レンダリング（ブラウザ拡張機能との互換性確保、例: 10ten Japanese Reader）
- 範囲選択で自動コピー、Cmd+C / Cmd+V クリップボード
- `ResizeObserver` でレスポンシブにフィット
- 切断時 2秒で自動再接続

## attach パターンの使い分け

### cwd モード（新規セッション）
```tsx
<WTx wsUrl="ws://host:3004" cwd="/workspace" />
```
サーバーが cwd に基づいてセッション名を生成（cwd の SHA1 から）。同じ cwd で再接続すると同じセッションに attach。

### session モード（既存セッション）
```tsx
<WTx wsUrl="ws://host:3004" session="agent-123" />
```
事前に `createSession("agent-123", [...])` で作ったセッションに attach。エージェントログ表示などで使用。

両方指定した場合 `session` が優先される。

## 例: 初期コマンドを送る

```tsx
<WTx
  wsUrl="/api/terminal"
  cwd="/repo"
  initialCmd="git status"
/>
```

接続確立直後に `git status\r` 相当の入力が送られる。

## 例: cwd 変更を追跡

```tsx
const [currentCwd, setCwd] = useState("/repo");

<WTx
  wsUrl="/api/terminal"
  cwd={currentCwd}
  onCwdChange={setCwd}
/>
```

シェル側で `cd` を実行すると `onCwdChange` に新しいパスが渡る（OSC 7 シーケンス経由）。

## 例: アクティビティ通知

```tsx
const [busy, setBusy] = useState(false);
const timer = useRef<number>();

<WTx
  wsUrl="/api/terminal"
  cwd="/repo"
  onActivity={() => {
    setBusy(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setBusy(false), 1000);
  }}
/>
```

## 例: カスタムテーマ

```tsx
<WTx
  wsUrl="/api/terminal"
  cwd="/repo"
  darkTheme={{
    background: "#0d1117",
    foreground: "#e6edf3",
    // ...
  }}
/>
```
