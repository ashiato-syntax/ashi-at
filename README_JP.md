[English](./README.md) | 日本語

# Ashi@ アーキテクチャおよび安全設計

## 1. 概要

Ashi@ は、[Ashiato Syntax](https://github.com/ashiato-syntax/ashiato-syntax) を含むSNS投稿を発見し、地図上に表示するためのWebサービスである。

Ashi@ はSNSそのものではなく、SNS投稿を蓄積するデータベースも運用しない。

Ashi@は、利用者のブラウザと対応SNSの間に位置する薄いサービスとして設計する。

主な設計目標は以下である。

- Ashi@が保持する情報を最小化する
- SNSアカウントとの不要な連携を行わない
- SNS投稿をサーバー側で収集しない
- インフラおよび運用コストを最小化する
- プライバシー、セキュリティ、法的リスクを低減する
- ユーザー体験を単純に保つ

---

## 2. 初期対応範囲

### 2.1 対応SNS

初期バージョンでは **Misskey** を対象とする。

Misskeyは、ブラウザから公開検索を実行でき、Ashi@に必要な検索方式を利用できるため、初期実装の対象とする。

### 2.2 Bluesky

Blueskyへの対応は保留する。

Misskey版を公開・運用した後、ブラウザ側検索、ページング、Rate Limit、APIの挙動、運用上の影響等を検証し、必要性と実現可能性を評価する。

追加SNSへの対応のために、サーバー側クロールや検索プロキシを導入することは原則として行わない。

---

## 3. 基本アーキテクチャ

Ashi@は**クライアントサイド発見方式**を採用する。

SNS検索は利用者のブラウザから直接実行する。

```text
                    ┌─────────────────┐
                    │     Browser     │
                    │    Ashi@ UI     │
                    └────────┬────────┘
                             │
                ┌────────────┴────────────┐
                │                         │
                ▼                         ▼
        ┌───────────────┐        ┌────────────────┐
        │    Misskey    │        │      Ashi@     │
        │ Public Search │        │ Issuance       │
        │   #Ashiato    │        │ Registry API   │
        └───────┬───────┘        └───────┬────────┘
                │                        │
                │ Notes                  │ hash
                ▼                        ▼
        Syntax extraction          visibility status
                │
                ▼
        Canonical Form
                │
                ▼
             Hash
                │
                └───────────────► Registry check
                                      │
                                      ▼
                               Visibility
```

Ashi@のバックエンドは、SNS検索結果そのものを受け取ったり保存したりしない。

---

## 4. クライアント側検索

Ashi@はSNS検索をフロントエンドから実行する。

Misskeyの場合、処理は以下のとおりである。

1. ブラウザから `#Ashiato` を検索する。
2. Misskeyから検索結果を直接取得する。
3. 各投稿からAshiato Syntaxを抽出する。
4. SyntaxのCanonical Formを生成する。
5. Canonical FormからHashを生成する。
6. Hashを使ってAshi@ Issuance Registryへ照会する。
7. Hashが存在し、`visibility` が `public` であればAshiatoを表示する。

SNS投稿そのものをAshi@のバックエンドへ送信しない。

---

## 5. 発見方法

Ashiato Syntax自体は、SNS上に投稿されたAshiatoの発見方法を規定しない。

Ashi@では、Misskey上で以下のハッシュタグを発見方式として使用する。

```text
#Ashiato
```

`#Ashiato` はAshi@のサービスレベルの規約であり、Ashiato Syntaxの仕様ではない。

他の実装は、異なる発見方法を採用してよい。

---

## 6. Issuance Registry

Ashi@は、SyntaxがAshi@によって発行されたものであるかを確認するため、Issuance Registryを使用する。

Ashi@が発行するSyntaxには、`x-*` 拡張フィールドを利用して発行IDを含める。

発行IDはSyntaxの一部であり、Canonical FormおよびHashの生成対象に含まれる。

Registryが保持する情報は以下の2項目のみとする。

```text
hash
visibility
```

SNS投稿の内容は保存しない。

Ashi@が発行するすべてのAshiatoは、通常Ashiato、秘密Ashiatoを問わずRegistryに登録する。Registryへの登録は、正規発行されたSyntaxであることを確認するためにも使用する。

### 6.1 Registryの意味

概念的には以下の意味を持つ。

```text
hash       : 発行済みSyntaxを識別するHash
visibility : Ashi@上での公開状態

`visibility` は以下の3状態を持つ。

```text
public
    → マップに表示する
    → 現地でも発見可能

unlisted
    → マップには表示しない
    → SNS上では現地で発見可能

suppressed
    → マップに表示しない
    → Ashi@の発見対象から除外する
```

`unlisted` と `suppressed` は意図的に区別する。
`unlisted` は秘密Ashiatoとして、マップには掲載しないが現地での発見を可能とする。
`suppressed` は非表示申請等によりAshi@上から除外されたAshiatoであり、Ashi@による発見対象からも除外する。
```

Registryには以下の情報を保存しない。

- 投稿本文
- 投稿者情報
- SNSアカウントID
- SNS投稿ID
- 投稿URL
- 画像
- 音声
- GPS座標
- SNS検索結果
- ユーザーアカウント
- 閲覧履歴

---

## 7. Hashによる識別

Ashi@は、発行IDとSNS投稿を直接関連付けない。

SyntaxそのものからCanonical Formを生成し、そのHashを識別子として使用する。

```text
Ashiato Syntax
      │
      ▼
Canonical Form
      │
      ▼
Hash
      │
      ▼
Issuance Registry
```

同一のSyntaxから同一のCanonical Formが生成されれば、同一のHashとなる。

これにより、Ashi@は元のSyntaxやSNS投稿を保存することなく、発行済みSyntaxを識別できる。

---

## 8. 不正コピーへの対策

正規のAshiato Syntaxを第三者がコピーし、正規投稿が検索に現れる前に偽投稿を作成する可能性がある。

コピーされたSyntaxは同一のHashを生成するため、同一Syntaxを含む検索結果が複数存在する場合は、古い投稿を優先して処理する。

これにより、コピーされた投稿によって正規投稿の認識が妨害される可能性を低減する。

Issuance Registryは、特定のSNSアカウントがその投稿を作成したことを証明するものではない。

---

## 9. Registryの保持期間

Registryの各エントリは、**7日後に自動削除する**。

削除にはデータベースのTTL機能を使用する。

アプリケーション側で定期的な削除バッチを実装することを前提としない。

```text
Registry entry
      │
      │ DB TTL
      ▼
    7 days
      │
      ▼
Automatic deletion
```

これにより、Ashi@が発行済みAshiatoの恒久的なインデックスを保持することを防ぐ。

### 9.1 データベースの最小化

Registryには原則として以下の2項目のみを保持する。

```text
hash
visibility
```

DBのTTL機能で有効期限を管理できる場合、不要な日時情報やメタデータを保存しない。

---

## 10. 未来日時のAshiato

Ashi@ v1では、**発行時点より未来の日時を指定するAshiatoを発行できない**。

これは、Issuance Registryを短期間かつ単純に保つための制約である。

Ashiato Syntax自体は未来日時の表現を禁止しない。

したがって、

```text
Ashiato Syntax
    └─ 未来日時の表現は可能

Ashi@
    └─ v1では未来日時の発行をサポートしない
```

未来日時のAshiatoは、将来の別機能として検討する。

---

## 11. 表示制御

Registryは `visibility` 値を保持する。

### `public`

```text
visibility = public
```

Ashi@のマップに表示する。SNS上で発見することもできる。

### `unlisted`

```text
visibility = unlisted
```

Ashi@のマップには表示しない。ただし、SNS上の投稿を現地で発見することは可能である。

`unlisted` は秘密Ashiatoに相当する。秘密AshiatoもRegistryには登録し、正規発行されたSyntaxとして扱う。

### `suppressed`

```text
visibility = suppressed
```

Ashi@のマップに表示せず、Ashi@の通常の発見対象からも除外する。非表示申請等によりAshi@上で非表示となったAshiatoに使用する。

`visibility` の変更はAshi@上での扱いだけに影響し、元のSNS投稿を削除・変更するものではない。

---

## 12. 非表示申請

Ashi@は、AshiatoをAshi@上で非表示にすることを申請できる仕組みを提供する。

この機能は、問題のあるAshiatoや望ましくないAshiatoをAshi@上で表示しないためのものである。

Ashi@は、対応SNS上の元投稿を削除・変更するものではない。

### 12.1 不正利用対策

非表示申請は、公開APIエンドポイントを直接呼び出すだけで成立してはならない。

フロントエンド上の30秒待機だけをセキュリティ対策として扱わず、サーバー側でも待機時間を検証する。

短時間のみ有効なChallengeを利用し、例えば以下のように処理する。

```text
Client
  │
  │ Start request
  ▼
Ashi@ server
  │
  ├─ Rate Limit
  ├─ Bot challenge
  └─ Issue temporary challenge
        │
        │ wait ≥ 30 seconds
        ▼
Client
  │
  │ Complete request
  ▼
Ashi@ server
  │
  ├─ Validate challenge
  ├─ Verify elapsed time
  ├─ Verify Bot protection
  ├─ Verify Rate Limit
  └─ Verify target hash
        │
        ▼
    visibility = suppressed
```

### 12.2 Rate Limit

大量の非表示申請による悪用を防止するため、Rate Limitを設ける。

必要に応じて、以下の対策を組み合わせる。

- IP単位のRate Limit
- セッション単位のRate Limit
- Hash単位の申請頻度制限
- Bot判定
- 短時間のみ有効なChallenge

IPアドレスを恒久的なユーザー識別子として扱わない。

---

## 13. 一時的な申請データ

非表示申請の処理に必要な情報は、一時的にのみ保持する。

恒久的な通報履歴や申請者データベースを原則として構築しない。

例えば一時的なChallengeには以下の情報を持たせることができる。

```text
challenge
target hash
creation time
```

Challengeは、処理完了またはタイムアウト後に自動的に失効させる。

---

## 14. Ashi@ユーザーアカウントを持たない

Ashi@はユーザー登録を要求しない。

Misskey等のSNSアカウントとのOAuthやアカウント連携も要求しない。

Ashi@は以下を保存しない。

- Misskeyアクセストークン
- SNSアカウントID
- ユーザープロフィール
- パスワード
- SNS認証情報

---

## 15. SNSコンテンツDBを持たない

Ashi@はSNSコンテンツのデータベースを構築しない。

特に以下を恒久的に保存しない。

- 投稿本文
- 投稿者
- 画像
- 音声
- コメント
- SNS URL
- 検索結果

対応SNSから必要な情報をブラウザが直接取得する。

---

## 16. 位置履歴を持たない

Ashi@は利用者の位置履歴を保持しない。

特に、

```text
user
+
time
+
location
```

を長期間関連付けるデータベースを構築しない。

Ashi@は利用者を追跡するサービスではない。

---

## 17. 位置情報のプライバシー

位置情報の公開によって、以下が推測される可能性がある。

- 個人の居場所
- 行動
- 生活圏
- 勤務先
- 私的な場所
- その他の個人情報

そのため、Ashi@は必要以上に高精度な位置情報を表示しない方針とする。

Ashi@では、例えば約100メートル単位の位置精度を既定の表示ポリシーとすることができる。

これはAshi@のサービス方針であり、Ashiato Syntax自体の必須仕様ではない。

---

## 18. 表示遅延

リアルタイムの位置追跡リスクを低減するため、新しく作成されたAshiatoを即時表示しない。

例えば、以下のように一定の遅延を設ける。

```text
SNS post
   │
   ▼
Waiting period
   │
   ▼
Ashi@ display
```

具体的な遅延時間はAshi@のサービス方針とし、Ashiato Syntaxの仕様には含めない。

---

## 19. 現地存在の証明ではない

Ashiato Syntaxに位置情報が含まれていても、そのSyntaxを生成・投稿した人物が指定地点に実際に存在したことを証明するものではない。

Ashi@はAshiatoを暗号学的または権威的な現地存在証明として扱わない。

将来的に現地存在証明が必要となった場合は、別途Proof of Presenceの仕組みとして設計する。

---

## 20. 暗号化モード

Ashiato Syntaxの暗号化モードは、v1では提供しない。

通常のAshiato Syntaxは公開情報として扱われるため、Ashi@以外の第三者が独自にSyntaxを解析し、独自のマップ等を作成すること自体を技術的に禁止しない。

将来的に、秘密Ashiatoの「現地に行かなければ内容を取得できない」という性質を暗号学的に保証する必要性が生じた場合は、暗号化または秘匿化の仕組みをAshiato Syntaxの別拡張として検討する。

v1では以下を目標としない。

- Ashi@以外によるAshiatoの表示を技術的に禁止すること
- 暗号鍵の配布・管理を行うこと
- 現地存在を暗号学的に証明すること

暗号化モードを追加する場合も、Ashiato Syntax本体の基本的な汎用性を損なわない形で設計する。

---

## 20. マップアーキテクチャ

Ashi@は商用地図APIへの依存を必要としない。

マップ表示には、例えば以下を利用できる。

- 白地図
- グリッド
- 座標ベースの描画
- 単純な地理形状
- Ashiatoマーカー

これにより、外部地図サービスへの依存、API利用制限、利用料金を抑える。

---

## 26. インフラの最小化

Ashi@はバックエンドインフラを最小化する。

バックエンドが提供する主な機能は以下である。

- Issuance Registry
- Hash照会
- 表示状態の変更
- 非表示申請処理

SNS検索はブラウザ側で実行する。

マップ描画は第三者の地図サービスを必須としない。

Ashi@は大規模なコンテンツデータベースを必要としない。

---

## 26. プライバシーおよびセキュリティ原則

Ashi@は以下の原則に従う。

1. 収集する情報を可能な限り少なくする。
2. SNS投稿を不必要に保存しない。
3. SNSアカウント情報を保存しない。
4. 恒久的なAshiatoインデックスを構築しない。
5. Registryエントリを7日後に自動削除する。
6. SNS検索をクライアント側で処理する。
7. 利用者の位置履歴を保持しない。
8. 位置精度および表示遅延による安全対策を行う。
9. 秘密Ashiatoと非表示AshiatoをRegistry上で区別する。
10. 非表示申請を自動化・大量送信されにくくする。
11. 一時的なセキュリティデータを短期間で失効させる。
12. v1では暗号化モードを導入せず、必要性が確認された場合に別拡張として検討する。

---

## 26. 法的・規約上の考慮事項

このアーキテクチャは、Ashi@が保持・処理する情報およびコンテンツを最小化することで、プライバシー、セキュリティ、法的リスクの低減を図るものである。

ただし、保持データを最小化しても、法的または契約上の責任がなくなることを意味しない。

以下については個別に確認する。

- 適用される個人情報保護法令
- 著作権
- プライバシーおよび人格権
- 名誉毀損
- 対応SNSの利用規約
- API利用条件
- 情報流通プラットフォーム等に関する法令
- 違法または権利侵害情報に関する申立て

Ashi@は、法的または権利上の問題に関する適切な連絡窓口を設ける。

公開前に、必要に応じて専門家による法的確認を行う。

---

## 26. 明示的な非目標

Ashi@は以下のサービスになることを目的としない。

- SNSそのもの
- SNS投稿アーカイブ
- SNS投稿の恒久的検索エンジン
- ユーザープロファイリングシステム
- 位置追跡サービス
- SNSアカウント管理サービス
- 外部SNSのコンテンツモデレーションプラットフォーム
- 長期的な位置情報データベース

新しい機能を追加する際は、これらの非目標に反しないかを確認する。

---

## 26. 設計の要約

Ashi@は**薄いサービスとして設計する**。

```text
                 Social Network
                       │
                 Public Search
                       │
                       ▼
                  User Browser
                       │
            ┌──────────┴──────────┐
            │                     │
            ▼                     ▼
      Syntax Processing      Ashi@ Registry
            │                     │
            │ hash                │
            └──────────►          │
                           visibility?
                               │
                     ┌─────────┴─────────┐
                     │                   │
                    yes                  no
                     │                   │
                     ▼                   ▼
                  Display             Hide
```

Ashi@はSNSデータそのものを所有・蓄積することを目的としない。

Ashi@が保持するのは、Ashi@が発行したAshiato Syntaxを識別し、そのAshiatoをAshi@上で表示するかどうかを判断するために必要な最小限の情報のみとする。

> **SNSがコンテンツを保持する。**
>
> **ブラウザがコンテンツを発見・処理する。**
>
> **Ashi@は短期間の発行確認と表示制御だけを提供する。**
