# GAYAラジTRPGトリテ Online

GitHub + Render でオンライン対戦できる版です。

## ローカル確認

```bash
npm install
npm start
```

ブラウザで `http://localhost:3000` を開きます。

## Render デプロイ

1. このフォルダを GitHub リポジトリにアップロード
2. Render で **New Web Service**
3. GitHub リポジトリを選択
4. Build Command: `npm install`
5. Start Command: `npm start`
6. Deploy

Render の Web Service は WebSocket を受けられます。サーバーは `process.env.PORT` を使って待ち受けます。

## 仕様

- WebSocket によるリアルタイム同期
- 4人オンライン対戦
- サーバー側でターン・手札・得点を管理
- 相手の手札内容は送信しません。手札枚数だけ共有します。
- 補充カードは自分の分だけ `+1` 表示されます。
- トリック獲得確認は5秒

## 再接続

参加後、ブラウザの localStorage に部屋番号・席・再接続トークンを保存します。通信が切れた場合はトップ画面の「前回の部屋に再接続」から同じ席に戻れます。

## CPU追加

待機室でホスト（席1）が空席にCPUを追加できます。「空席をCPUで埋める」を押すと、人が足りない状態でも4人分そろえて開始できます。

## 修正メモ

CPU追加/解除が動かない原因は、クライアントが `{type, data:{...}}` 形式で送信しているのに、サーバー側が `data.seat` のようにトップ階層を読んでいたためです。サーバー側で `payload = data.data || {}` を読むように修正しました。

## CPU実況

CPUがカードを出した時、トリックを獲得した時、補充した時に、役割に応じた短い実況コメントを表示します。コメントは場のカード下に小さく出るため、手札操作を邪魔しません。
