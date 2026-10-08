/* 会報ごとの設定（会報スタジオの ⚙ 設定が書き出す）。
   members: 名簿。role は editor（編集長）/ staff（担当者）/ viewer（閲覧者）。
            pass は合言葉の SHA-256（名前と組）。平文を書かないこと。
   templates: page-templates.js の上書き。markup[0] は 1 ページ目の見本。
   手で直すときは JSON として正しい形を保つこと。

   この brands/default/ は見本のブランドなので、名簿も見本（架空の人）です。
   実際の会報では brands/<組織>/ に brands/_template/settings.js を写して使います。 */
window.KAIHO_SETTINGS = {
  "members": [
    { "name": "佐藤 里美", "role": "editor", "contact": "sato@example.org", "pass": "" },
    { "name": "田村 健一", "role": "staff", "contact": "tamura@example.org", "pass": "" },
    { "name": "小林 あすか", "role": "staff", "contact": "kobayashi@example.org", "pass": "" },
    { "name": "田中 誠", "role": "staff", "contact": "tanaka@example.org", "pass": "" },
    { "name": "鈴木 由紀", "role": "staff", "contact": "suzuki@example.org", "pass": "" },
    { "name": "山本 和夫", "role": "viewer", "contact": "yamamoto@example.org", "pass": "" }
  ],
  "templates": {}
};
