/* ============================================================================
   kaiho-studio / system/page-templates.js
   ----------------------------------------------------------------------------
   記事テンプレート（docs/10-page-templates.md）の定義。

   「号テンプレート」（templates/basic-8p.html 等、号まるごと）と違い、
   ここで定義するのは「記事 1 本ぶんの雛型」。編集計画の記事が
   1 つ選ぶことで、白紙のページに <h2> と 2 段組が置かれるだけの
   状態から、特集・活動報告といった型に沿った紙面が組み上がる。

   このファイルは紙面の CSS を一切生成しない。HTML の雛型（文字列）を
   持つだけで、DOM には触れない。属性を実際の .page 要素に適用したり、
   「紙面を編集計画に合わせる」を実行するのは system/editor.js の仕事
   （docs/10 §3.2, §4 の「実装時に必ず直すもの」）。

   editor.js より前に読み込むこと。editor.js が
   window.KAIHO_ARTICLE_TEMPLATES を参照する前提で書かれる。
   号テンプレートの <script> の並びは変えない
   （tokens → brand → print → components → editor.css の順で CSS を読み、
   その後に page-templates.js → editor.js の順で JS を読む）。
   ========================================================================== */

(function () {
  "use strict";

  /* markup() が使ってよいのは system/components.css と system/print.css に
     実在するクラス名だけ。存在しないクラス名を発明しないこと
     （見本帳に無い部品は次の担当者から見て存在しないのと同じ、CLAUDE.md）。
     色・文字サイズ・背景を style で直書きしない。寸法の一時指定
     （style="width: 34mm;" 等）だけは gallery.html p4 の例外規定に従う。

     pageAttrs[pageIndex] が無いときは配列の最後の要素を使う契約になっている
     （占有ページ数は編集長が後から増やせるため）。実際に DOM へ適用するのは
     editor.js 側の仕事なので、このファイルはデータを並べるだけに留める。 */

  window.KAIHO_ARTICLE_TEMPLATES = [

    /* ------------------------------------------------------------------
       表紙・もくじ（templates/basic-8p.html p1 から起こす）
       ------------------------------------------------------------------ */
    {
      id: "cover",
      label: "表紙・もくじ",
      pages: 1,
      once: true,
      fixed: "first",
      toc: false,
      pageAttrs: [
        { folio: "none", runhead: "" }
      ],
      markup: function (id) {
        return '<article class="article" data-article="' + id + '">\n' +
          '  <header class="masthead">\n' +
          '    <img class="masthead__logo" src="../brands/default/logo.svg" alt="団体名">\n' +
          '    <h1 class="masthead__title" data-editable>会報タイトル</h1>\n' +
          '    <p class="masthead__meta t-num" data-editable>第00号　2026年1月発行</p>\n' +
          '  </header>\n' +
          '  <figure class="fig--16x9 mb-8">\n' +
          '    <img src="../system/placeholder.svg" alt="表紙写真の内容を説明する代替テキスト">\n' +
          '    <figcaption data-editable>\n' +
          '      表紙写真のキャプション\n' +
          '      <span class="fig__credit" data-editable>撮影：氏名</span>\n' +
          '    </figcaption>\n' +
          '  </figure>\n' +
          '  <p class="t-lead" data-editable>\n' +
          '    表紙リード。この号の中心となる話題を、2〜3行で読者に手渡します。\n' +
          '  </p>\n' +
          /* 目次は data-toc="auto" の中身を editor.js の renderToc() が毎回作り直す
             （docs/10 §5）。data-editable を付けない＝手で編集できない。
             ここに書いても次の再生成で黙って消えるため。 */
          '  <nav aria-label="目次" class="fill">\n' +
          '    <h2 class="t-h3">もくじ</h2>\n' +
          '    <ul class="toc" data-toc="auto"></ul>\n' +
          '  </nav>\n' +
          '</article>';
      }
    },

    /* ------------------------------------------------------------------
       巻頭あいさつ（basic-8p.html p2 から起こす）
       ------------------------------------------------------------------ */
    {
      id: "greeting",
      label: "巻頭あいさつ",
      pages: 1,
      once: false,
      fixed: null,
      toc: true,
      pageAttrs: [
        { runhead: "巻頭あいさつ" }
      ],
      markup: function (id) {
        return '<article class="article" data-article="' + id + '">\n' +
          '  <h2 class="t-h1" data-editable>巻頭のごあいさつ</h2>\n' +
          '  <div class="cols-2 cols-rule fill">\n' +
          '    <figure class="fig--1x1" style="width: 34mm;">\n' +
          '      <img class="portrait" src="../system/placeholder.svg" alt="会長の顔写真">\n' +
          '      <figcaption data-editable>会長　氏名</figcaption>\n' +
          '    </figure>\n' +
          '    <div class="t-body" data-editable>\n' +
          '      <p>本文が入ります。段組の中で自然に流れます。</p>\n' +
          '    </div>\n' +
          '  </div>\n' +
          '  <p class="byline" data-editable>\n' +
          '    <span class="byline__role">会長</span>\n' +
          '    <span class="byline__name">氏名</span>\n' +
          '  </p>\n' +
          '</article>';
      }
    },

    /* ------------------------------------------------------------------
       特集記事（basic-8p.html p3-p4 から起こす。2 ページ組）
       前半: 大見出し＋リード／後半: 2 段組＋抜き刷り＋囲み
       ------------------------------------------------------------------ */
    {
      id: "feature",
      label: "特集記事",
      pages: 2,
      once: false,
      fixed: null,
      toc: true,
      pageAttrs: [
        { runhead: "特集" },
        { runhead: "特集" }
      ],
      markup: function (id, pageIndex) {
        if (pageIndex === 0) {
          return '<article class="article" data-article="' + id + '">\n' +
            '  <span class="t-band" data-editable>特集</span>\n' +
            '  <h2 class="t-h1" data-editable>特集の見出しがここに入ります</h2>\n' +
            '  <p class="t-lead" data-editable>\n' +
            '    特集のリード文。何についての記事か、なぜ今それを扱うのかを短く示します。\n' +
            '  </p>\n' +
            '  <div class="cols-2 cols-rule fill" data-editable>\n' +
            '    <p>本文が入ります。</p>\n' +
            '    <h3 class="t-h3">小見出し</h3>\n' +
            '    <p>小見出しは段の中に置けます。</p>\n' +
            '    <blockquote class="pullquote">\n' +
            '      引用や、記事中の印象的な一文をここに置きます。\n' +
            '      <span class="pullquote__source">— 話者名</span>\n' +
            '    </blockquote>\n' +
            '    <p>本文の続きです。</p>\n' +
            '  </div>\n' +
            '</article>';
        }
        return '<article class="article" data-article="' + id + '">\n' +
          '  <h2 class="t-h2" data-editable>中見出し</h2>\n' +
          '  <figure class="fig--16x9">\n' +
          '    <img src="../system/placeholder.svg" alt="図版の内容を説明する代替テキスト">\n' +
          '    <figcaption data-editable>\n' +
          '      図版のキャプション\n' +
          '      <span class="fig__credit" data-editable>出典：◯◯</span>\n' +
          '    </figcaption>\n' +
          '  </figure>\n' +
          '  <div class="cols-2 fill" data-editable>\n' +
          '    <p>本文が入ります。</p>\n' +
          '    <p>本文の続きです。</p>\n' +
          '  </div>\n' +
          '  <aside class="callout" data-editable>\n' +
          '    <span class="callout__label">おことわり</span>\n' +
          '    補足や注意事項をここに書きます。\n' +
          '  </aside>\n' +
          '</article>';
      }
    },

    /* ------------------------------------------------------------------
       活動報告（basic-8p.html p5 から起こす）
       ------------------------------------------------------------------ */
    {
      id: "report",
      label: "活動報告",
      pages: 1,
      once: false,
      fixed: null,
      toc: true,
      pageAttrs: [
        { runhead: "活動報告" }
      ],
      markup: function (id) {
        return '<article class="article" data-article="' + id + '">\n' +
          '  <h2 class="t-h1" data-editable>活動報告</h2>\n' +
          '  <div class="grid mb-8" style="grid-template-columns: repeat(2, 1fr);">\n' +
          '    <figure class="fig--4x3">\n' +
          '      <img src="../system/placeholder.svg" alt="活動の様子を説明する代替テキスト">\n' +
          '      <figcaption data-editable>行事名（開催日）</figcaption>\n' +
          '    </figure>\n' +
          '    <figure class="fig--4x3">\n' +
          '      <img src="../system/placeholder.svg" alt="活動の様子を説明する代替テキスト">\n' +
          '      <figcaption data-editable>行事名（開催日）</figcaption>\n' +
          '    </figure>\n' +
          '  </div>\n' +
          '  <div class="cols-2 fill" data-editable>\n' +
          '    <h3 class="t-h3">行事名</h3>\n' +
          '    <p>報告の本文が入ります。</p>\n' +
          '    <h3 class="t-h3">行事名</h3>\n' +
          '    <p>報告の本文が入ります。</p>\n' +
          '  </div>\n' +
          '</article>';
      }
    },

    /* ------------------------------------------------------------------
       データで見る一年（basic-8p.html p6 から起こす）
       ------------------------------------------------------------------ */
    {
      id: "data",
      label: "データで見る一年",
      pages: 1,
      once: false,
      fixed: null,
      toc: true,
      pageAttrs: [
        { runhead: "データ" }
      ],
      markup: function (id) {
        return '<article class="article" data-article="' + id + '">\n' +
          '  <h2 class="t-h1" data-editable>データで見る一年</h2>\n' +
          '  <table class="table table--zebra" data-editable>\n' +
          '    <caption class="visually-hidden">年度別の活動実績</caption>\n' +
          '    <thead>\n' +
          '      <tr><th scope="col">項目</th><th scope="col">前年度</th><th scope="col">今年度</th></tr>\n' +
          '    </thead>\n' +
          '    <tbody>\n' +
          '      <tr><td>会員数</td><td class="t-num">000</td><td class="t-num">000</td></tr>\n' +
          '      <tr><td>行事開催数</td><td class="t-num">00</td><td class="t-num">00</td></tr>\n' +
          '      <tr><td>延べ参加者数</td><td class="t-num">0,000</td><td class="t-num">0,000</td></tr>\n' +
          '    </tbody>\n' +
          '  </table>\n' +
          '  <div class="box fill" data-editable>\n' +
          '    <h3 class="box__title">補足</h3>\n' +
          '    <p>集計方法や注記をここに書きます。</p>\n' +
          '  </div>\n' +
          '</article>';
      }
    },

    /* ------------------------------------------------------------------
       お知らせ・行事予定（basic-8p.html p7 から起こす）
       ------------------------------------------------------------------ */
    {
      id: "notice",
      label: "お知らせ・行事予定",
      pages: 1,
      once: false,
      fixed: null,
      toc: true,
      pageAttrs: [
        { runhead: "お知らせ" }
      ],
      markup: function (id) {
        return '<article class="article" data-article="' + id + '">\n' +
          '  <h2 class="t-h1" data-editable>お知らせ</h2>\n' +
          '  <div class="box box--brand" data-editable>\n' +
          '    <h3 class="box__title">重要なお知らせ</h3>\n' +
          '    <p>会員に必ず届けたい内容をここに置きます。</p>\n' +
          '  </div>\n' +
          '  <h2 class="t-h2" data-editable>行事予定</h2>\n' +
          '  <dl class="deflist fill" data-editable>\n' +
          '    <div class="deflist__row"><dt class="deflist__key t-num">0/00</dt><dd>行事名（会場・時間）</dd></div>\n' +
          '    <div class="deflist__row"><dt class="deflist__key t-num">0/00</dt><dd>行事名（会場・時間）</dd></div>\n' +
          '  </dl>\n' +
          '</article>';
      }
    },

    /* ------------------------------------------------------------------
       編集後記・奥付（basic-8p.html p8 から起こす）
       ------------------------------------------------------------------ */
    {
      id: "colophon",
      label: "編集後記・奥付",
      pages: 1,
      once: true,
      fixed: "last",
      toc: false,
      pageAttrs: [
        { runhead: "奥付" }
      ],
      markup: function (id) {
        return '<article class="article" data-article="' + id + '">\n' +
          '  <h2 class="t-h1" data-editable>編集後記</h2>\n' +
          '  <div class="t-body" data-editable>\n' +
          '    <p>編集を終えての一言をここに。</p>\n' +
          '  </div>\n' +
          '  <footer class="colophon" data-editable>\n' +
          '    <p><strong>会報タイトル　第00号</strong>　2026年1月発行</p>\n' +
          '    <p>発行：団体名　／　編集：広報委員会</p>\n' +
          '    <p>〒000-0000　住所<br>\n' +
          '       電話 000-000-0000　／　mail@example.org</p>\n' +
          '  </footer>\n' +
          '</article>';
      }
    },

    /* ------------------------------------------------------------------
       裏表紙
       既存の号テンプレートに現物が無いため新規に組む（依頼の許可事項）。
       ベタ面に白抜きの部品は .t-band しか無い（背景トークンだけの汎用
       ユーティリティクラスは padding も文字色反転も持たず、.box--brand は
       淡色の囲みで白抜き用ではない）。全面ベタのパネルを作るには
       components.css への部品追加が要り、それは gallery.html / docs/03 の
       更新が必須になる MVP 範囲外の変更。
       ここでは .t-band（自前でベタ面と白抜きを持つ）と、地色の上にそのまま
       乗る .t-body / .colophon の組み合わせだけで組む。
       離れた 2 つの規則の記述順（カスケードの後勝ち）に見た目を依存させない
       こと。components.css の節が並べ替わると気づかれずに壊れるため。

       colophon（編集後記・奥付）と back（裏表紙）はどちらも奥付を持つ。
       両方を号に使うと奥付が 2 回出るので、併用する号では奥付をどちらか
       一方に寄せる運用にすること（重複検査は段階4で追加）。
       ------------------------------------------------------------------ */
    {
      id: "back",
      label: "裏表紙",
      pages: 1,
      once: true,
      fixed: "last",
      toc: false,
      pageAttrs: [
        { folio: "none", runhead: "" }
      ],
      markup: function (id) {
        return '<article class="article" data-article="' + id + '">\n' +
          '  <span class="t-band" data-editable>ご愛読ありがとうございました</span>\n' +
          '  <div class="t-body fill" data-editable>\n' +
          '    <p>次号もお楽しみに。ご意見・ご感想をお待ちしています。</p>\n' +
          '  </div>\n' +
          '  <footer class="colophon" data-editable>\n' +
          '    <p><strong>会報タイトル　第00号</strong>　2026年1月発行</p>\n' +
          '    <p>発行：団体名　／　編集：広報委員会</p>\n' +
          '    <p>〒000-0000　住所<br>\n' +
          '       電話 000-000-0000　／　mail@example.org</p>\n' +
          '  </footer>\n' +
          '</article>';
      }
    },

    /* ------------------------------------------------------------------
       自由（現行 editor.js の articleMarkup() と同じ内容にする指定）。
       pageIndex は常に 0（占有ページ数 1）なので primary は常に true。
       ------------------------------------------------------------------ */
    {
      id: "free",
      label: "自由",
      pages: 1,
      once: false,
      fixed: null,
      toc: true,
      pageAttrs: [
        { runhead: "" }
      ],
      markup: function (id) {
        return '<article class="article" data-article="' + id + '">\n' +
          '  <h2 class="t-h1" data-editable>記事タイトル</h2>\n' +
          '  <div class="cols-2 fill" data-editable>\n' +
          '    <p>本文をここに入力します。</p>\n' +
          '  </div>\n' +
          '</article>';
      }
    }

  ];

  /* 既存の号・見本帳からの参照を保つ互換名。 */
  window.KAIHO_PAGE_TEMPLATES = window.KAIHO_ARTICLE_TEMPLATES;

})();
