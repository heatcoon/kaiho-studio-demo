/* ============================================================================
   kaiho-studio / system/editor.js
   ----------------------------------------------------------------------------
   号の作業台。工程（計画 → 原稿作成 → 校正 → 入稿）と、会報ごとの設定
   （テンプレート・名簿）を持つ。依存ライブラリなし。

   設計上の約束ごと:

   1. 紙面の見た目に関わる CSS は一切ここで生成しない。
      画面に見えている紙面は print.css / components.css だけで組まれており、
      このスクリプトは「作業台の道具」しか足さない。
      → プレビューと印刷結果が乖離しない構造的な保証になる。
      記事の割合は style="--share: 45%" という値だけを渡し、規則は
      components.css が持つ（docs/00 決定 12）。
      例外は2つ。いずれも中身がすべて編集計画（と articlePlacement()）から
      導出され、CSS は一切生成しないため許容している。
      （1）台割シート。会報そのものではなく制作用の帳票で、紙面には触れない。
      （2）表紙の目次（data-toc="auto"）。renderToc() が毎回作り直す。
          こちらは紙面の内容そのものなので、保存される HTML にも残す。
          例外を3つめに増やすときは、この判断そのものを見直すこと。

   2. 保存される HTML には編集用 UI を一切残さない。
      ツールバー・パネル・設定・ログイン・ガイド・ページ道具・制作スラグ・
      台割シート・作業用の属性はすべて読み込み時に生成し、serialize() が取り除く。
      → git の差分が「原稿の差分」だけになる（docs/08 の前提）。
      新しい DOM や属性を足したら、serialize() の除去リストに必ず足すこと。

   3. 唯一の情報源は HTML そのもの。
      編集計画も号のメタ情報も <script type="application/json" id="kaiho-meta">
      に持つ。ただし「作業の途中経過」は号の HTML に入れない（docs/09 §3.1）。
      校正コメントは号の隣の comments.js、名簿とテンプレートの定型は
      会報ごとの brands/<組織>/settings.js に分けて持つ。

   4. 担当者は「記事」に付く。ページではない。
      ページを占有するのは「枠」で、記事は枠の中の割合を持つ（決定 11・12）。
      ページをまたぐ記事は計画の側で「続き」に分けて書く（決定 13）。

   5. ログインは本人確認ではない。
      ローカルの HTML は誰でもテキストエディタで開いて書き換えられる。
      名簿と合言葉は「誰として作業しているか」を画面に決めるためのもので、
      本当の権限制御はサーバ版（docs/09）でしか成り立たない。
   ========================================================================== */

(function () {
  "use strict";

  /* ==========================================================================
     定数
     ========================================================================== */

  /* 要件11: 現在選択できるのは A4 のみ。
     B5/A5 を解禁するときは enabled を true にし、
     print.css の [data-format] ブロックのコメントを外す。 */
  var FORMATS = [
    { id: "A4", label: "A4（210×297mm）", enabled: true },
    { id: "B5", label: "B5（182×257mm）", enabled: false },
    { id: "A5", label: "A5（148×210mm）", enabled: false }
  ];

  var MAX_PAGES = 20;   /* 要件12。枠の占有ページ数の上限にも効く */
  var MIN_PAGES = 1;

  /* 記事ごとに進む4工程（決定 1）。校了は終端で期日を持たない（決定 1-b）。
     順序がそのまま進行順になる */
  var STAGES = [
    { id: "manuscript", label: "原稿締切", short: "原稿" },
    { id: "proof1",     label: "初校",     short: "初校" },
    { id: "proof2",     label: "再校",     short: "再校" },
    { id: "signoff",    label: "校了",     short: "校了" }
  ];

  /* 入校は号にひとつだけ。記事の上書きを持たない（決定 1） */
  var FINAL_STAGE_ID = "final";

  /* 号の工程（決定 14）。記事の工程（STAGES）とは別物。
     ここは「いま画面で何をしているか」で、保存しない */
  var STEPS = [
    { id: "plan",    label: "計画",     who: "編集長" },
    { id: "write",   label: "原稿作成", who: "担当者" },
    { id: "proof",   label: "校正",     who: "全員" },
    { id: "release", label: "入稿",     who: "編集長" }
  ];

  var ROLE_LABELS = { editor: "編集長", staff: "担当者", viewer: "閲覧者" };

  var STEP_HELP = {
    plan: "ページにセクションを置き、その中に記事を配置します。セクションと記事はそれぞれの型を選びます。",
    write: "記事の「原稿を書く」から紙面を開き、青い枠の中を押して入力します。変更したら保存しましょう。",
    proof: "紙面を読み、気になる文章を選んでコメントを付けます。確認が終わった記事を校了にします。",
    release: "検査と確認項目を見直してから、印刷用データを出力します。背景あり・A4・倍率100%で印刷してください。"
  };

  /* 割合は％（0〜100の5の倍数）か "rest"（残り）。既定で見えるのは
     この7つだけ。「細かく調整」を開くと5%刻みで動かせる（決定 12）。
     値は1つ（share そのもの）。データに2系統は作らない */
  var SHARE_PRESETS = [
    { value: 100,    label: "全面" },
    { value: 75,     label: "3/4" },
    { value: 65,     label: "2/3" },
    { value: 50,     label: "1/2" },
    { value: 35,     label: "1/3" },
    { value: 25,     label: "1/4" },
    { value: "rest", label: "残り" }
  ];

  /* 入稿前チェック（人が見るもの、決定 7）。状態は保存しない。
     「校正情報を解除した」は無い。入稿の工程に入ると自動で外れる（決定 14） */
  var VISUAL_CHECKLIST = [
    "印刷ダイアログで「背景のグラフィック」を有効にした",
    "号数・発行日が正しい",
    "奥付の住所・連絡先が最新か確認した",
    "写真の解像度・トリミングを確認した",
    "誤字・固有名詞の表記ゆれを確認した"
  ];

  /* 判定 4: パネルの幅は可変。担当者列は 460px 以上で出る（CSS の @container） */
  var PANEL_MIN = 380;
  var PANEL_MAX = 520;

  /* 設定で直したテンプレートの markup の中で、記事 ID が入る場所の目印 */
  var ARTICLE_TOKEN = "__ARTICLE__";
  var SECTION_TOKEN = "__SECTION__";

  var DEFAULT_META = {
    issue: "",
    date: "",
    format: "A4",
    /* 原稿・初校・再校は記事の締切の既定値、final は号の入校日（決定 1-a） */
    schedule: {},
    /* 発行済みの号。true にすると督促を止め、全工程を完了として扱う */
    released: false,
    editor: { name: "", contact: "" },
    plan: {
      sections: [],   /* { id, title, template, pages, articles: [記事ID…] } */
      articles: []    /* { id, title, share, owner, contact, current, schedule } / { id, continues, share } */
    }
  };

  /* ==========================================================================
     ちいさなユーティリティ
     ========================================================================== */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "text") { node.textContent = attrs[k]; }
        else if (k === "html") { node.innerHTML = attrs[k]; }
        else if (k.indexOf("on") === 0 && typeof attrs[k] === "function") {
          node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        } else if (attrs[k] !== null && attrs[k] !== undefined) {
          node.setAttribute(k, attrs[k]);
        }
      });
    }
    (children || []).forEach(function (c) {
      if (!c) { return; }
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  function todayISO() { return new Date().toISOString().slice(0, 10); }
  function mmdd(iso) { return iso ? iso.replace(/-/g, "/").slice(5) : "—"; }

  function escapeHTML(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function daysLate(due) {
    if (!due) { return 0; }
    var d = (new Date(todayISO()) - new Date(due)) / 86400000;
    return Math.max(0, Math.round(d));
  }

  /* ==========================================================================
     状態
     ========================================================================== */

  var state = {
    meta: null,
    metaText: "",      /* 最後に #kaiho-meta へ書いた JSON。差があるときだけ書き直す */
    dirty: { issue: false, comments: false, settings: false },
    step: "plan",      /* いまの工程。導出の既定値を人が選び直せる。保存しない */
    viewer: null,      /* ログイン中の人（名簿の1行）。保存しない */
    setupMode: false,  /* 名簿が無い。開いた人を編集長として扱っている */
    settings: null,    /* 会報ごとの設定（brands/<組織>/settings.js） */
    templates: null,   /* page-templates.js に設定の上書きを重ねたもの */
    comments: [],      /* 校正コメント（号の隣の comments.js） */
    quote: null,       /* 紙面で選んだ引用の控え */
    editorFocus: null, /* 決定 15: 編集長が原稿作成で選んだ絞り込み。null = 全員、"" = 担当未設定 */
    checklist: {},     /* 入稿前の目視チェック。保存しない */
    settingsTab: "sectionTemplates",
    templateId: null,
    tplMode: "text",
    root: null         /* 作業フォルダ（File System Access API のディレクトリハンドル） */
  };

  /* ==========================================================================
     ファイルの場所
     --------------------------------------------------------------------------
     号の HTML は issues/<号>/index.html、テンプレートは templates/*.html と
     階層が違う。設定・コメント・テンプレートの画像の場所は、すべて号の HTML が
     実際に読んでいる <link> から割り出す（固定のパスを書くと階層で壊れる）。
     ========================================================================== */

  function linkHref(fileName) {
    var link = $$('link[rel="stylesheet"]').find(function (l) {
      return (l.getAttribute("href") || "").split("?")[0].split("/").pop() === fileName;
    });
    return link ? link.getAttribute("href") : null;
  }

  /* system/ の1つ上（リポジトリの根）への相対パス。例: "../../" */
  function rootPrefix() {
    var href = linkHref("tokens.css") || linkHref("editor.css");
    if (!href) { return "../"; }
    return href.replace(/system\/[^/]*$/, "");
  }

  /* 号が使っているブランドのフォルダ（例: "brands/default/"）。根からの相対 */
  function brandDir() {
    var href = linkHref("brand.css");
    if (!href) { return "brands/default/"; }
    var m = /(brands\/[^/]+\/)brand\.css/.exec(href);
    return m ? m[1] : "brands/default/";
  }

  function settingsURL() { return rootPrefix() + brandDir() + "settings.js"; }

  /* 号の HTML のファイル名から、コメントの置き場所を決める。
     index.html → comments.js、それ以外は <名前>.comments.js */
  function commentsFileName() {
    var name = decodeURIComponent(location.pathname.split("/").pop() || "index.html");
    return name === "index.html" ? "comments.js" : name.replace(/\.html?$/, "") + ".comments.js";
  }

  /* page-templates.js の markup は templates/ から見た相対パス（"../system/…"）と、
     見本のブランド（brands/default/）で書かれている。号の階層とブランドに合わせて読み替える */
  function rebaseMarkup(html) {
    var prefix = rootPrefix();
    var brand = brandDir();
    return String(html)
      .replace(/(src|href)="\.\.\/(?!\.\.\/)/g, '$1="' + prefix)
      .split(prefix + "brands/default/").join(prefix + brand);
  }

  /* rebaseMarkup() の逆。設定ファイルには page-templates.js と同じ形で書く。
     でないと、別の階層の号で使ったときに画像の場所がずれる */
  function canonicalMarkup(html) {
    var prefix = rootPrefix();
    var brand = brandDir();
    return String(html)
      .split(prefix + brand).join("../brands/default/")
      .split('src="' + prefix).join('src="../')
      .split('href="' + prefix).join('href="../');
  }

  /* 設定とコメントは <script> で読む。file:// では fetch() が使えないため。
     読み込みに失敗しても（ファイルがまだ無い）作業は続けられる */
  function loadSidecar(url) {
    return new Promise(function (resolve) {
      var s = document.createElement("script");
      s.src = url;
      s.setAttribute("data-kaiho-injected", "true");
      s.onload = function () { resolve(true); };
      s.onerror = function () { resolve(false); };
      document.head.appendChild(s);
    });
  }

  /* ==========================================================================
     メタ情報の読み書き
     ========================================================================== */

  function readMeta() {
    var node = $("#kaiho-meta");
    var meta = JSON.parse(JSON.stringify(DEFAULT_META));
    if (node) {
      try {
        var parsed = JSON.parse(node.textContent || "{}");
        Object.keys(parsed).forEach(function (k) { meta[k] = parsed[k]; });
      } catch (e) {
        console.warn("[kaiho] #kaiho-meta の JSON を解釈できませんでした:", e);
      }
    }
    if (!meta.schedule) { meta.schedule = {}; }
    if (!meta.editor) { meta.editor = { name: "", contact: "" }; }
    if (!meta.plan) { meta.plan = { frames: [], articles: [] }; }
    if (!Array.isArray(meta.plan.articles)) { meta.plan.articles = []; }
    if (!Array.isArray(meta.plan.frames)) { meta.plan.frames = []; }
    if (!meta.format) { meta.format = "A4"; }
    /* 廃止前の手入力の総ページ数。枠の pages の合計が総ページ数になった */
    delete meta.plan.pages;

    /* 決定 1-a: 旧 meta.current（号全体の工程）は記事へ1度だけ移して捨てる。
       号の工程を残すと記事ごとの工程と必ず食い違う */
    var legacyCurrent = meta.current;
    delete meta.current;

    meta.plan.articles.forEach(function (a) {
      if (!a.continues) {
        var cur = a.current || legacyCurrent || "manuscript";
        /* 旧「入校」まで進んでいた記事は、直すところが無い＝校了とみなす */
        if (cur === FINAL_STAGE_ID) { cur = "signoff"; }
        if (!STAGES.some(function (st) { return st.id === cur; })) { cur = "manuscript"; }
        a.current = cur;
        if (!a.schedule) { a.schedule = {}; }
        /* 入校は号だけの値（決定 1）。記事に残っていても使われない */
        delete a.schedule[FINAL_STAGE_ID];
      }
      /* 決定 12: 決定 11 の分数（"1/2" 等）や未指定を％か "rest" に読み替える */
      a.share = normalizeShareValue(a.share);
    });

    migrateZeroPageArticles(meta);
    migrateArticleTemplates(meta);
    migrateSections(meta);
    return meta;
  }

  /* 決定 11 以前の「占有ページ数 0 ＝ 直前の記事と同居」を、枠に読み替える。
     同居していた記事の並びを、直前の記事を先頭にした1つの枠にまとめる。
     紙面には触れない（入れ物の形は変えない）ので、開いただけで原稿は動かない */
  function migrateZeroPageArticles(meta) {
    var arts = meta.plan.articles;
    var covered = {};
    meta.plan.frames.forEach(function (f) { (f.articles || []).forEach(function (id) { covered[id] = true; }); });
    for (var i = 1; i < arts.length; i++) {
      var a = arts[i], prev = arts[i - 1];
      if (a.continues || covered[a.id] || String(a.pages) !== "0" || prev.continues) { continue; }
      var f = meta.plan.frames.find(function (x) { return (x.articles || []).indexOf(prev.id) >= 0; });
      if (!f) {
        f = {
          id: "f-" + prev.id, title: prev.title || prev.id, template: prev.template || "free",
          articles: [prev.id]
        };
        if (prev.pages !== undefined && prev.pages !== "") { f.pages = parseInt(prev.pages, 10) || 1; }
        meta.plan.frames.push(f);
        covered[prev.id] = true;
        delete prev.pages;
      }
      f.articles.push(a.id);
      covered[a.id] = true;
      delete a.pages;
    }
  }

  /* 旧枠のテンプレートを記事へ移す。原稿DOMには触れず、明示済みの型を優先する。 */
  function migrateArticleTemplates(meta) {
    meta.plan.frames.forEach(function (frame) {
      (frame.articles || []).forEach(function (id) {
        var a = meta.plan.articles.find(function (item) { return item.id === id; });
        if (a && !a.continues && !a.template) { a.template = frame.template || "free"; }
      });
      delete frame.template;
    });
    meta.plan.articles.forEach(function (a) {
      if (a.continues) { delete a.template; }
      else if (!a.template) { a.template = "free"; }
    });
  }

  /* 枠・暗黙の枠を明示的なセクションに移す。記事所属の情報源は articles[] だけ。 */
  function migrateSections(meta) {
    var plan = meta.plan, list = Array.isArray(plan.sections) ? plan.sections : [];
    (plan.frames || []).forEach(function (frame) {
      if (list.some(function (section) { return section.id === frame.id; })) { return; }
      var first = plan.articles.find(function (a) { return (frame.articles || []).indexOf(a.id) >= 0 && !a.continues; });
      list.push({ id: frame.id, title: frame.title || (first && first.title) || "セクション",
        template: first && first.template === "report" ? "report" : "standard",
        pages: frame.pages, articles: (frame.articles || []).slice() });
    });
    var used = {};
    list.forEach(function (section) {
      section.template = section.template || "standard";
      section.articles = Array.isArray(section.articles) ? section.articles : [];
      section.articles.forEach(function (id) { used[id] = true; });
    });
    plan.articles.forEach(function (a) {
      if (used[a.id]) { return; }
      var parentSection = a.continues && list.find(function (section) { return section.articles.indexOf(a.continues) >= 0; });
      if (parentSection) { parentSection.articles.push(a.id); used[a.id] = true; return; }
      var id = "s-" + a.id, n = 1;
      while (list.some(function (section) { return section.id === id; })) { id = "s-" + a.id + "-" + n++; }
      list.push({ id: id, title: a.title || "セクション", template: a.template === "report" ? "report" : "standard",
        pages: a.pages, articles: [a.id] });
      used[a.id] = true;
    });
    plan.articles.forEach(function (a) { delete a.pages; });
    plan.sections = list;
    delete plan.frames;
  }

  /* meta を DOM へ書き戻す。中身が変わったときだけ書いて「未保存」にする。
     変更のたびに呼び出し元で書き忘れる事故を、ここ1か所で防ぐ */
  function syncMeta() {
    var text = JSON.stringify(state.meta, null, 2);
    if (text === state.metaText) { return; }
    state.metaText = text;
    var node = $("#kaiho-meta");
    if (!node) {
      node = el("script", { type: "application/json", id: "kaiho-meta" });
      document.body.appendChild(node);
    }
    node.textContent = "\n" + text + "\n";
    markDirty("issue");
  }

  function anyDirty() { return state.dirty.issue || state.dirty.comments || state.dirty.settings; }

  function markDirty(kind) {
    state.dirty[kind || "issue"] = true;
    renderSaveState();
  }

  function renderSaveState() {
    var dirty = anyDirty();
    $$(".kaiho-savestate").forEach(function (s) {
      s.setAttribute("data-dirty", dirty ? "true" : "false");
      var parts = [];
      if (state.dirty.issue) { parts.push("号"); }
      if (state.dirty.comments) { parts.push("コメント"); }
      if (state.dirty.settings) { parts.push("設定"); }
      s.textContent = dirty ? "未保存（" + parts.join("・") + "）" : "保存済み";
    });
  }

  /* ==========================================================================
     会報ごとの設定（名簿・テンプレートの定型）
     ========================================================================== */

  function readSettings() {
    var s = window.KAIHO_SETTINGS;
    s = (s && typeof s === "object") ? JSON.parse(JSON.stringify(s)) : {};
    if (!Array.isArray(s.members)) { s.members = []; }
    if (!s.articleTemplates || typeof s.articleTemplates !== "object") { s.articleTemplates = {}; }
    Object.keys(s.templates || {}).forEach(function (id) {
      if (!s.articleTemplates[id]) { s.articleTemplates[id] = s.templates[id]; }
    });
    if (!s.sectionTemplates || typeof s.sectionTemplates !== "object") { s.sectionTemplates = {}; }
    delete s.templates;
    s.members.forEach(function (m) {
      if (!ROLE_LABELS[m.role]) { m.role = "staff"; }
      if (!m.contact) { m.contact = ""; }
      if (!m.pass) { m.pass = ""; }
    });
    return s;
  }

  function members() { return state.settings.members; }
  function memberByName(name) {
    return members().find(function (m) { return m.name === name; }) || null;
  }

  /* ==========================================================================
     記事テンプレート（system/page-templates.js ＋ 設定の上書き）
     --------------------------------------------------------------------------
     過去号は page-templates.js を読み込まない（docs/08 の worktree で当時の
     システムごと開く前提）。無くても例外を出さず "free" 1 件で動く。
     ========================================================================== */

  var FALLBACK_TEMPLATES = [
    {
      id: "free", label: "自由", pages: 1, once: false, fixed: null, toc: true,
      pageAttrs: [{ runhead: "" }],
      markup: function (id) { return articleMarkup(id, true); }
    }
  ];

  function baseTemplates() {
    var list = window.KAIHO_ARTICLE_TEMPLATES || window.KAIHO_PAGE_TEMPLATES;
    return (Array.isArray(list) && list.length) ? list : FALLBACK_TEMPLATES;
  }

  /* 設定の上書きを重ねた一覧を作り直す。設定のテンプレートを直したら呼ぶ */
  function rebuildTemplates() {
    var base = baseTemplates();
    var edits = state.settings ? state.settings.articleTemplates : {};
    var list = base.map(function (t) { return applyTemplateEdit(t, edits[t.id]); });
    /* 設定で新しく作ったテンプレート。土台は free */
    var free = base.find(function (t) { return t.id === "free"; }) || base[0];
    Object.keys(edits).forEach(function (id) {
      if (base.some(function (t) { return t.id === id; })) { return; }
      var custom = Object.assign({}, free, { id: id, label: "新しいテンプレート", once: false, fixed: null });
      list.push(applyTemplateEdit(custom, edits[id]));
    });
    state.templates = list;
    var sectionEdits = state.settings ? state.settings.sectionTemplates : {};
    var sectionBase = baseSectionTemplates();
    state.sectionTemplates = sectionBase.map(function (t) { return applyTemplateEdit(t, sectionEdits[t.id], "section"); });
    Object.keys(sectionEdits).forEach(function (id) {
      if (sectionBase.some(function (t) { return t.id === id; })) { return; }
      state.sectionTemplates.push(applyTemplateEdit(Object.assign({}, sectionBase[0], {
        id: id, label: "新しいセクションテンプレート"
      }), sectionEdits[id], "section"));
    });
  }

  function applyTemplateEdit(t, edit, kind) {
    var copy = Object.assign({}, t);
    if (!edit) { return copy; }
    ["label", "pages", "fixed", "toc", "once", "layout", "heading"].forEach(function (k) {
      if (edit[k] !== undefined) { copy[k] = edit[k]; }
    });
    if (Array.isArray(edit.markup) && edit.markup.length) {
      var original = t.markup;
      copy.markup = function (id, pageIndex) {
        var idx = pageIndex || 0;
        if (typeof edit.markup[idx] === "string") { return edit.markup[idx].split(kind === "section" ? SECTION_TOKEN : ARTICLE_TOKEN).join(id); }
        return original ? original(id, idx) : articleMarkup(id, true);
      };
    }
    return copy;
  }

  function articleTemplates() { return state.templates || baseTemplates(); }

  /* 見つからなければ free、free も無ければ配列の先頭を返す。null は返さない契約 */
  function templateById(id) {
    var list = articleTemplates();
    var found = null, free = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) { found = list[i]; }
      if (list[i].id === "free") { free = list[i]; }
    }
    return found || free || list[0];
  }

  /* templateById() と違い、見つからなければ null。綴り間違いを検査で拾うためだけに使う */
  function findTemplateRaw(id, kind) {
    return templatesOf(kind).find(function (t) { return t.id === id; }) || null;
  }

  function baseSectionTemplates() {
    var list = window.KAIHO_SECTION_TEMPLATES;
    return Array.isArray(list) && list.length ? list : [{ id: "standard", label: "標準セクション", layout: "stack", heading: true,
      markup: function (id) { return '<section class="content-section" data-section="' + id + '"><h2 class="t-h2 content-section__title" data-section-title data-editable>セクション見出し</h2><div class="content-section__articles" data-section-articles></div></section>'; } }];
  }
  function sectionTemplates() { return state.sectionTemplates || baseSectionTemplates(); }
  function sectionTemplateById(id) {
    return sectionTemplates().find(function (t) { return t.id === id; }) || sectionTemplates()[0];
  }
  function templatesOf(kind) { return kind === "section" ? sectionTemplates() : articleTemplates(); }
  function templateKind() { return state.settingsTab === "sectionTemplates" ? "section" : "article"; }
  function settingsMap(kind) { return kind === "section" ? state.settings.sectionTemplates : state.settings.articleTemplates; }
  function sectionById(id) { return sections().find(function (section) { return section.id === id; }) || null; }
  function sectionPages(id) { return pages().filter(function (page) { return !!$('[data-section="' + id + '"]', page); }); }

  function sectionHolder(section, pageIndex) {
    var t = sectionTemplateById(section.template), holder = el("div");
    holder.innerHTML = rebaseMarkup(t.markup(section.id, pageIndex || 0));
    var node = $('[data-section]', holder);
    if (!node) { node = el("section", { "class": "content-section", "data-section": section.id }); }
    node.classList.add("content-section");
    node.setAttribute("data-section", section.id);
    node.setAttribute("data-layout", t.layout === "columns" ? "columns" : "stack");
    var slot = $("[data-section-articles]", node);
    if (!slot) { slot = el("div", { "class": "content-section__articles", "data-section-articles": "" }); node.appendChild(slot); }
    slot.classList.add("content-section__articles");
    var title = $("[data-section-title]", node);
    if (title) { if (title.hasAttribute("data-editable")) { title.textContent = section.title || t.label; } title.hidden = t.heading === false; }
    return node;
  }

  /* 既存の原稿は display:contents の器で包み、改行・写真・紙面の寸法を保つ。 */
  function migrateSectionDOM() {
    pages().forEach(function (page) {
      var body = $(".page__body", page), previous = null;
      if (!body) { return; }
      Array.prototype.slice.call(body.children).forEach(function (node) {
        var id = node.getAttribute("data-article");
        if (!id) { previous = null; return; }
        var section = sectionOfArticle(id), sectionId = section ? section.id : "unplanned-" + id;
        var wrapper = previous && previous.getAttribute("data-section") === sectionId ? previous : null;
        if (!wrapper) {
          wrapper = el("section", { "class": "content-section content-section--legacy", "data-section": sectionId }, [
            el("div", { "class": "content-section__articles", "data-section-articles": "" })
          ]);
          body.insertBefore(wrapper, node);
        }
        $("[data-section-articles]", wrapper).appendChild(node);
        previous = wrapper;
      });
    });
  }

  function balanceSections(page) {
    var nodes = $$(":scope > .page__body > [data-section]", page);
    nodes.forEach(function (node) {
      node.classList.toggle("content-section--allocated", nodes.length > 1);
      node.style.setProperty("--section-share", String(100 / nodes.length) + "%");
    });
  }

  function ensureSectionOnPage(page, section) {
    var node = $('[data-section="' + section.id + '"]', page);
    if (!node) {
      node = sectionHolder(section, sectionPages(section.id).length);
      $(".page__body", page).appendChild(node);
      balanceSections(page);
    }
    return $("[data-section-articles]", node);
  }

  function applySectionTemplate(section) {
    sectionPages(section.id).forEach(function (page, index) {
      var old = $('[data-section="' + section.id + '"]', page), node = sectionHolder(section, index);
      var slot = $("[data-section-articles]", node), oldSlot = $("[data-section-articles]", old);
      while (oldSlot.firstChild) { slot.appendChild(oldSlot.firstChild); }
      $$('[data-article]', slot).forEach(function (article) { article.classList.add("article--block", "article--flow"); });
      old.replaceWith(node);
      balanceSections(page);
    });
    articles().forEach(function (a) { applyShareToDOM(a.id, a.share); });
    markDirty("issue");
  }
  function syncSectionTitle(section) {
    pages().forEach(function (page) {
      var node = $('[data-section="' + section.id + '"] [data-section-title]', page);
      if (node && node.hasAttribute("data-editable") && node.textContent !== section.title) { node.textContent = section.title; }
    });
  }

  /* ==========================================================================
     編集計画（ページ・セクション・記事）
     --------------------------------------------------------------------------
     セクションが共通見出し・並べ方・確保ページ数を持ち、記事はその中の割合を持つ。
     旧号の枠と独立記事は readMeta() で明示的なセクションへ移す（決定 17）。
     ========================================================================== */

  function articles() { return state.meta.plan.articles; }
  function sections() { return state.meta.plan.sections; }

  function articleById(id) {
    for (var i = 0; i < articles().length; i++) {
      if (articles()[i].id === id) { return articles()[i]; }
    }
    return null;
  }

  function effectiveSections() { return sections(); }

  function sectionOfArticle(articleId) {
    return effectiveSections().find(function (f) { return (f.articles || []).indexOf(articleId) >= 0; }) || null;
  }

  function articleTemplate(a) {
    var owner = a && ownerArticle(a);
    return templateById(owner && owner.template);
  }

  /* pages が未指定ならテンプレートの既定値に落とす */
  function sectionPlannedPages(frame) {
    if (frame.pages !== undefined && frame.pages !== null && frame.pages !== "") {
      var p = parseInt(frame.pages, 10);
      if (!isNaN(p) && p >= 0) { return Math.min(p, MAX_PAGES); }
    }
    return Math.max.apply(null, [1].concat((frame.articles || []).map(function (id) {
      return articleTemplate(articleById(id)).pages || 1;
    })));
  }

  /* 総ページ数は枠の pages の合計（決定 11）。手入力の欄は無い */
  function plannedTotal() {
    var occupied = [], missing = 0;
    sections().forEach(function (section) {
      var actual = sectionPages(section.id);
      actual.forEach(function (page) { if (occupied.indexOf(page) < 0) { occupied.push(page); } });
      missing += Math.max(0, sectionPlannedPages(section) - actual.length);
    });
    return occupied.length + missing;
  }

  /* 枠の占有ページ数を書き換える。暗黙の枠なら記事の側に書く */
  function setSectionPages(frame, v) {
    var target = frame;
    if (isNaN(v)) { delete target.pages; } else { target.pages = Math.max(0, Math.min(MAX_PAGES, v)); }
  }

  function setArticleTemplate(a, id) {
    if (!isEditor() || a.continues) { return; }
    a.template = id;
    var frame = sectionOfArticle(a.id);
    /* 他の記事と分け合う枠のページ数は、型の変更だけでは増減させない。 */
    if (frame && frame.articles.length === 1 && !articlePages(a.id).length) { frame.pages = templateById(id).pages || 1; }
    rerenderAll();
  }

  /* 割合: 5%刻みに丸め、0〜100へ収める */
  function clampShare(n) {
    n = Math.round(n / 5) * 5;
    return Math.max(0, Math.min(100, n));
  }

  function normalizeShareValue(share) {
    if (share === undefined || share === null || share === "" || share === "rest" || share === "auto") { return "rest"; }
    if (typeof share === "number") { return clampShare(share); }
    if (typeof share === "string") {
      var frac = /^(\d+)\s*\/\s*(\d+)$/.exec(share);
      if (frac) {
        var den = parseInt(frac[2], 10);
        if (den > 0) { return clampShare((parseInt(frac[1], 10) / den) * 100); }
      }
      var n = parseFloat(share);
      if (!isNaN(n)) { return clampShare(n); }
    }
    return "rest";
  }

  function shareToNumber(share) { return (typeof share === "number") ? share / 100 : null; }

  /* 決定 13: 「続き」はタイトル・担当者・連絡先・締切・工程を持たない。
     参照する箇所はすべて ownerArticle() を通して親の値を使う */
  function primaryArticles() { return articles().filter(function (a) { return !a.continues; }); }

  function continuationOf(articleId) {
    return articles().find(function (a) { return a.continues === articleId; }) || null;
  }

  function ownerArticle(a) {
    if (a && a.continues) { return articleById(a.continues) || a; }
    return a;
  }

  function displayTitleOf(article) {
    if (!article) { return "記事"; }
    if (article.continues) {
      var parent = articleById(article.continues);
      return "続き（" + (parent ? parent.title : article.continues) + "）";
    }
    return article.title || "無題の記事";
  }

  /* 記事ごとの3工程（原稿・初校・再校）だけが号の既定へのフォールバックを持つ。
     校了は期日を持たない。入校は号だけの値（決定 1） */
  function dueOf(article, stageId) {
    var a = ownerArticle(article);
    if (stageId === "signoff") { return ""; }
    if (stageId === FINAL_STAGE_ID) { return state.meta.schedule[FINAL_STAGE_ID] || ""; }
    if (a && a.schedule && a.schedule[stageId]) { return a.schedule[stageId]; }
    return state.meta.schedule[stageId] || "";
  }

  /* 決定 1-a: 「号の既定に従う」は無い。記事は必ず自分の工程を持つ */
  function currentOf(article) {
    var a = ownerArticle(article);
    return (a && a.current) || "manuscript";
  }

  function stageState(article, stageId) {
    if (state.meta.released) { return "done"; }
    var idx = STAGES.findIndex(function (s) { return s.id === stageId; });
    var cur = STAGES.findIndex(function (s) { return s.id === currentOf(article); });
    if (cur < 0) { cur = 0; }
    if (idx < cur) { return "done"; }
    if (idx === cur) {
      /* 校了は終端。そこにいる記事は直すところが無いので督促しない */
      if (stageId === "signoff") { return "done"; }
      var due = dueOf(article, stageId);
      return (due && due < todayISO()) ? "overdue" : "current";
    }
    return "future";
  }

  function stateLabel(st) {
    return { done: "完了", current: "進行中", overdue: "期日超過", future: "未着手" }[st] || st;
  }

  /* 決定 1-b: 校了＝入稿できる状態の唯一の指標 */
  function signoffDone(article) {
    return state.meta.released || currentOf(article) === "signoff";
  }

  function signoffCount() {
    var arts = primaryArticles();
    return { done: arts.filter(signoffDone).length, total: arts.length };
  }

  function advanceStage(article, stageId) {
    article.current = stageId;
    rerenderAll();
  }

  function newId(prefix, exists) {
    var n = 1;
    while (exists(prefix + n)) { n++; }
    return prefix + n;
  }
  function newArticleId() { return newId("art-", function (id) { return !!articleById(id); }); }
  function newSectionId() {
    return newId("f-", function (id) { return sections().some(function (f) { return f.id === id; }); });
  }

  /* 記事を計画に足す。既定では「自分1本だけの暗黙の枠」になる */
  function addSection(preset) {
    var section = { id: newSectionId(), title: "新しいセクション " + (sections().length + 1),
      template: "standard", pages: 1, articles: [] };
    Object.keys(preset || {}).forEach(function (key) { section[key] = preset[key]; });
    sections().push(section);
    return section;
  }

  function addArticle(preset, section) {
    var a = {
      id: newArticleId(), title: "無題の記事 " + (primaryArticles().length + 1),
      template: "free", share: "rest", owner: "", contact: "",
      current: "manuscript", schedule: {}
    };
    Object.keys(preset || {}).forEach(function (key) { a[key] = preset[key]; });
    articles().push(a);
    if (!section) { section = addSection({ title: a.title, pages: a.pages || templateById(a.template).pages || 1 }); }
    delete a.pages;
    section.articles.push(a.id);
    return a;
  }

  function explicitSection(section) { return section; }

  /* 記事 id を記事の並び（articles()）の中で、指定の記事の直後へ動かす。
     枠の並び順は記事の並び順から導くので、ここを揃えないと台割が入れ替わる */
  function placeAfter(id, afterId) {
    var list = articles();
    var from = list.findIndex(function (a) { return a.id === id; });
    var item = list.splice(from, 1)[0];
    var to = list.findIndex(function (a) { return a.id === afterId; });
    list.splice(to + 1, 0, item);
  }

  function addArticleToSection(frame) {
    var f = explicitSection(frame);
    var lastId = f.articles[f.articles.length - 1];
    var a = addArticle({ share: f.articles.length ? 50 : "rest" }, f);
    if (lastId) { placeAfter(a.id, lastId); }
    /* 先頭の記事が「残り」のままだと、2本とも余りを取り合う */
    var first = articleById(f.articles[0]);
    if (first && first !== a && first.share === "rest") { first.share = 50; applyShareToDOM(first.id, 50); }
    return a;
  }

  function addContinuation(parent) {
    var frame = sectionOfArticle(parent.id);
    var f = explicitSection(frame);
    var child = { id: newId(parent.id + "-", function (id) { return !!articleById(id); }), continues: parent.id, share: "rest" };
    articles().push(child);
    var idx = f.articles.indexOf(parent.id);
    f.articles.splice(idx + 1, 0, child.id);
    placeAfter(child.id, parent.id);
    if (sectionPlannedPages(f) < 2) { f.pages = 2; }
    return child;
  }

  /* 記事を計画から外す。紙面の入れ物は残す（中の原稿を黙って消さない）。
     残った入れ物は検査が「計画に無い記事」として指摘する */
  function deleteArticle(a) {
    var child = continuationOf(a.id);
    var msg = "「" + displayTitleOf(a) + "」を編集計画から外します。\n" +
              "紙面の入れ物と原稿は残るので、不要ならページ道具の ✕ で外してください。" +
              (child ? "\nこの記事の続きも一緒に外れます。" : "");
    if (!confirm(msg)) { return; }
    var ids = [a.id].concat(child ? [child.id] : []);
    state.meta.plan.articles = articles().filter(function (x) { return ids.indexOf(x.id) < 0; });
    sections().forEach(function (f) {
      f.articles = (f.articles || []).filter(function (id) { return ids.indexOf(id) < 0; });
    });
    rerenderAll();
  }

  function deleteSection(f) {
    if ((f.articles || []).length) { return; }
    sectionPages(f.id).forEach(function (page) {
      $$('[data-section="' + f.id + '"]', page).forEach(function (node) {
        if (!$('[data-article]', node)) { node.remove(); markDirty(); }
      });
      balanceSections(page);
    });
    state.meta.plan.sections = sections().filter(function (x) { return x !== f; });
    rerenderAll();
  }

  /* ==========================================================================
     紙面の走査（計画にページ番号を持たせないための導出値）
     ========================================================================== */

  /* 設定画面のテンプレート見本も .page を使うので、号の紙面（body 直下）だけを数える */
  function pages() {
    return Array.prototype.slice.call(document.body.children).filter(function (n) {
      return n.classList.contains("page");
    });
  }

  function pageNumberOf(page) { return pages().indexOf(page) + 1; }

  /* 紙面のどこに記事が置かれているかは、計画ではなく markup から読む。
     計画側にページ番号を持たせると、原稿を動かした瞬間に食い違うため */
  function articlePlacement() {
    var map = {};
    pages().forEach(function (page, i) {
      var seen = {};
      $$("[data-article]", page).forEach(function (node) {
        var id = node.getAttribute("data-article");
        if (!id || seen[id]) { return; }
        seen[id] = true;
        if (!map[id]) { map[id] = { first: i + 1, last: i + 1, pages: [] }; }
        map[id].last = i + 1;
        map[id].pages.push(i + 1);
      });
    });
    return map;
  }

  function placementLabel(pl) {
    if (!pl) { return "未配置"; }
    if (pl.first === pl.last) { return "p." + pl.first; }
    return "p." + pl.first + "–" + pl.last;
  }

  /* 決定 13: 親と続きを合わせた掲載範囲。articlePlacement() 自体は生の値のまま
     （続きの前後関係を見る検査は、合流前の値を比べる必要がある） */
  function mergedPlacement(articleId, placement) {
    var pl = placement[articleId];
    var child = continuationOf(articleId);
    var childPl = child ? placement[child.id] : null;
    if (!childPl) { return pl || null; }
    if (!pl) { return childPl; }
    return { first: Math.min(pl.first, childPl.first), last: Math.max(pl.last, childPl.last),
             pages: pl.pages.concat(childPl.pages) };
  }

  function placementLabelForArticle(articleId, placement) {
    return placementLabel(mergedPlacement(articleId, placement));
  }

  /* 記事が実在するページ（DOM ノード）。新しいページの挿入位置を決めるのに使う */
  function articlePages(articleId) {
    return pages().filter(function (page) {
      return !!$('[data-article="' + articleId + '"]', page);
    });
  }

  function articleNode(articleId) {
    return $('.page .article--block[data-article="' + articleId + '"]');
  }

  /* 表紙の目次を毎回作り直す（docs/10 §5）。手入力は残さない。
     項目 = 枠のテンプレートの toc が true で、紙面に配置されている記事（続きは親だけ）。
     ページ番号は articlePlacement() が数えた実際の先頭ページ */
  function renderToc() {
    var containers = $$('.page [data-toc="auto"]');
    if (!containers.length) { return; }
    var placement = articlePlacement();
    var items = primaryArticles()
      .map(function (a) { return { a: a, pl: mergedPlacement(a.id, placement) }; })
      .filter(function (x) { return x.pl && articleTemplate(x.a).toc; })
      .sort(function (x, y) { return x.pl.first - y.pl.first; });

    containers.forEach(function (list) {
      var html = items.map(function (x) {
        return '<li class="toc__item"><span class="toc__title">' + escapeHTML(x.a.title) +
               '</span><span class="toc__page t-num">' + x.pl.first + "</span></li>";
      }).join("");
      /* 中身が同じなら触らない。触ると入力中の選択範囲などが飛ぶ */
      if (list.innerHTML !== html) { list.innerHTML = html; }
    });
  }

  /* ==========================================================================
     ページの装飾（ガイド・ページ道具・制作スラグ）
     ========================================================================== */

  function decoratePages() {
    pages().forEach(function (page, i) {
      /* 左右ページの別。1ページ目を右起こしとする */
      page.setAttribute("data-side", i % 2 === 0 ? "right" : "left");
      if (!$(".page__guides", page)) {
        page.appendChild(el("div", { "class": "page__guides", "aria-hidden": "true" }));
      }
      renderSlug(page);
      renderPageTools(page);
    });
  }

  /* 制作情報スラグ（要件13）。そのページに載っている記事ごとに 1 行。
     続きのページにも親の担当者・締切が出る（誰に戻すかが紙の上で分かる） */
  function renderSlug(page) {
    var old = $(".production-slug", page);
    if (old) { old.remove(); }

    var ids = [];
    $$("[data-article]", page).forEach(function (n) {
      var a = articleById(n.getAttribute("data-article"));
      var id = a ? ownerArticle(a).id : n.getAttribute("data-article");
      if (id && ids.indexOf(id) < 0) { ids.push(id); }
    });

    var slug = el("div", { "class": "production-slug" });
    if (!ids.length) {
      slug.appendChild(el("div", { "class": "production-slug__row" }, [
        el("span", { "class": "production-slug__warn", text: "記事が割り当てられていません" })
      ]));
      page.appendChild(slug);
      return;
    }

    ids.forEach(function (id) {
      var a = articleById(id);
      var stages = STAGES.map(function (s) {
        var st = stageState(a, s.id);
        return el("span", {
          "class": "production-slug__stage", "data-state": st,
          text: s.id === "signoff" ? s.short : s.short + " " + mmdd(dueOf(a, s.id))
        });
      });
      /* 入校は号の値。全記事に同じ日付が出る */
      stages.push(el("span", { "class": "production-slug__stage",
        text: "入校 " + mmdd(dueOf(a, FINAL_STAGE_ID)) }));
      slug.appendChild(el("div", { "class": "production-slug__row" }, [
        el("span", { "class": "production-slug__title", text: a ? a.title : "（計画に無い記事: " + id + "）" }),
        el("span", { "class": "production-slug__owner", text: (a && a.owner) || "担当者未設定" }),
        el("span", { "class": "production-slug__contact", text: (a && a.contact) || "" }),
        el("span", { "class": "production-slug__stages" }, stages)
      ]));
    });
    page.appendChild(slug);
  }

  /* ページ道具（右上）。計画の工程で編集長が、ページに記事の入れ物を足し引きする。
     それ以外の工程・役割では記事名と（校正中は）コメント数だけを見せる */
  function renderPageTools(page) {
    var old = $(".page-tools", page);
    if (old && old.contains(document.activeElement)) { return; }   /* 選びかけを飛ばさない */
    if (old) { old.remove(); }

    var editing = state.step === "plan" && isEditor();
    var ids = [];
    $$("[data-article]", page).forEach(function (n) {
      var id = n.getAttribute("data-article");
      if (id && ids.indexOf(id) < 0) { ids.push(id); }
    });

    var chips = ids.map(function (id) {
      var a = articleById(id);
      var owner = ownerArticle(a);
      var open = owner ? openCommentCount(owner.id) : 0;
      return el("span", { "class": "page-tools__chip", "data-orphan": a ? null : "true" }, [
        el("span", { text: a ? displayTitleOf(a) : "計画に無い: " + id }),
        (state.step === "proof" && open) ? el("span", { "class": "page-tools__count", text: "コメント " + open }) : null,
        editing ? el("button", {
          type: "button", "class": "page-tools__drop", text: "✕",
          title: "この記事の入れ物をこのページから外す",
          onclick: function () {
            var node = $('[data-article="' + id + '"]', page);
            if (node) { removeArticleFromPage(node); }
          }
        }) : null
      ]);
    });

    var tools = el("div", { "class": "page-tools" }, chips);
    if (editing) {
      tools.appendChild(pageActions(page));
      tools.appendChild(buildSectionAssignment(page));
    }
    page.appendChild(tools);
  }

  /* ==========================================================================
     ページと記事の入れ物を組む
     ========================================================================== */

  /* 記事1本だけのページの入れ物。テンプレートが無い（過去号）ときの雛型でもある */
  function articleMarkup(id, primary) {
    return '<article class="article" data-article="' + id + '">\n' +
           '  <h2 class="' + (primary ? "t-h1" : "t-h2") + '" data-editable>記事タイトル</h2>\n' +
           '  <div class="cols-2' + (primary ? " fill" : "") + '" data-editable>\n' +
           '    <p>本文をここに入力します。</p>\n' +
           '  </div>\n' +
           '</article>';
  }

  /* .page を1枚組み立てる。まだ DOM には挿入しない（挿入位置は呼び出し側の事情） */
  function composePage(bodyHTML, tmpl, pageIndex) {
    var attrsList = (tmpl && tmpl.pageAttrs) || [];
    var attrs = attrsList[pageIndex] || attrsList[attrsList.length - 1] || {};
    var page = el("section", { "class": "page" });
    if (attrs.folio === "none") { page.setAttribute("data-folio", "none"); }
    page.innerHTML =
      '<div class="page__body">\n' + rebaseMarkup(bodyHTML) + '\n</div>\n' +
      '<span class="page__runhead" data-editable></span>\n' +
      '<span class="page__folio"></span>';
    var runhead = $(".page__runhead", page);
    if (runhead) { runhead.textContent = attrs.runhead || ""; }
    return page;
  }

  /* 枠の記事を、割合に沿ってページごとの組に分ける。
     割合の合計が 100% に達するか「残り」が入ったら、そのページは閉じる。
     記事が1本だけの枠は、その記事がすべてのページを占める（特集の2ページ組など） */
  function sectionGroups(frame) {
    var ids = (frame.articles || []).filter(function (id) { return !!articleById(id); });
    var planned = sectionPlannedPages(frame);
    if (ids.length <= 1) {
      var g = [];
      for (var i = 0; i < planned; i++) { g.push(ids.slice()); }
      return g;
    }
    var groups = [], cur = [], sum = 0, closed = false;
    ids.forEach(function (id) {
      var s = articleById(id).share;
      if (cur.length && (closed || (s !== "rest" && sum + s > 102))) {
        groups.push(cur); cur = []; sum = 0; closed = false;
      }
      cur.push(id);
      if (s === "rest") { closed = true; } else { sum += s; if (sum >= 98) { closed = true; } }
    });
    if (cur.length) { groups.push(cur); }
    return groups.slice(0, Math.max(planned, 1));
  }

  /* 同じページを分け合う場合も、各記事の型から入れ物を作る。 */
  function articleHolder(a, pageIndex, block) {
    var tmpl = articleTemplate(a), holder = el("div");
    var index = a.continues ? 1 : pageIndex || 0;
    holder.innerHTML = rebaseMarkup(tmpl.markup ? tmpl.markup(a.id, index) : articleMarkup(a.id, !index));
    var node = $('[data-article]', holder);
    if (!node) {
      node = el("article", { "class": "article", "data-article": a.id });
      while (holder.firstChild) { node.appendChild(holder.firstChild); }
    }
    node.setAttribute("data-article", a.id);
    if (block) { node.classList.add("article--block", "article--flow"); }
    return node;
  }

  function composeGroupPage(section, group, pageIndex) {
    var node = sectionHolder(section, pageIndex);
    var slot = $("[data-section-articles]", node);
    group.forEach(function (id) { slot.appendChild(articleHolder(articleById(id), pageIndex, true)); });
    return composePage(node.outerHTML, group.length === 1 ? articleTemplate(articleById(group[0])) : null, pageIndex);
  }

  function insertAfterNode(node, anchor) {
    if (anchor) { anchor.parentNode.insertBefore(node, anchor.nextSibling); return; }
    var first = pages()[0];
    if (first) { first.parentNode.insertBefore(node, first); }
    else {
      var meta = $("#kaiho-meta");
      if (meta) { meta.parentNode.insertBefore(node, meta); } else { document.body.appendChild(node); }
    }
  }

  /* 不足しているページを、編集計画に沿ってテンプレートの雛型で作る（docs/10 §4）。

     この処理には削除の経路を一切持たせない。押すのは編集長で、消えるとしたら
     担当者が書いた原稿になる。一括操作の確認ダイアログは押し間違いが起きやすく、
     安全な削除手段（各ページの「削除」と、記事入れ物の「✕」。どちらも対象が目に見えている）
     が既にあるので、それで足りる。計画より多いページ・計画に無い記事は、
     ここでは何もせず検査に指摘を委ねる。

     並び順は枠の並び（記事の並び順）どおり。既存のページは動かさない
     （動かすと原稿の位置が変わる）。 */
  function syncPagesToPlan() {
    var list = effectiveSections();
    if (!list.length) {
      alert("編集計画に記事がありません。まず「＋ 記事を足す」で記事を登録してください。");
      return;
    }
    var anchor = null, created = 0, hitMax = false;

    list.forEach(function (frame) {
      if (hitMax) { return; }
      var groups = sectionGroups(frame);
      var single = (frame.articles || []).length <= 1;
      var existingAll = sectionPages(frame.id).slice();
      (frame.articles || []).forEach(function (id) {
        articlePages(id).forEach(function (p) { if (existingAll.indexOf(p) < 0) { existingAll.push(p); } });
      });
      existingAll.sort(function (x, y) { return pageNumberOf(x) - pageNumberOf(y); });

      groups.forEach(function (group, gi) {
        if (hitMax) { return; }
        var present;
        if (single) {
          /* 1本の記事が複数ページを占める枠。gi 枚目が紙面にあるかで見る */
          present = existingAll[gi] || null;
        } else {
          present = existingAll.find(function (p) {
            return group.some(function (id) { return !!$('[data-article="' + id + '"]', p); });
          }) || null;
        }
        if (present) {
          /* ページはあるが、同じページを分け合う記事の入れ物がまだ無い（枠に記事を
             足した直後）。ページの末尾に足すだけで、既存の入れ物には触れない */
          if (!single) {
            var body = ensureSectionOnPage(present, frame);
            group.forEach(function (id) {
              if (body && !articlePages(id).length) {
                body.appendChild(articleHolder(articleById(id), 0, true));
                created++;
              }
            });
          }
          anchor = present;
          return;
        }
        if (pages().length >= MAX_PAGES) { hitMax = true; return; }
        var page = composeGroupPage(frame, group, gi);
        insertAfterNode(page, anchor || (existingAll.length ? existingAll[existingAll.length - 1] : null));
        anchor = page;
        created++;
      });
      if (existingAll.length) {
        var last = existingAll[existingAll.length - 1];
        if (!anchor || pageNumberOf(last) > pageNumberOf(anchor)) { anchor = last; }
      }
    });

    if (created) { afterPagesChanged(); }
    showBarToast(created ? "ページと記事の入れ物を " + created + " か所作りました" : "足りないページはありません");
    if (hitMax) {
      alert("ページ数の上限（" + MAX_PAGES + " ページ）に達したため、途中までしか作成できませんでした。" +
            "計画の占有ページ数を減らしてください。");
    }
  }

  function afterPagesChanged() {
    migrateSectionDOM();
    articles().forEach(function (a) { applyShareToDOM(a.id, a.share); });
    decoratePages();
    markDirty("issue");
    rerenderAll();
  }

  /* ページは記事から独立した器。末尾に白紙を足し、あとから記事を配置する。 */
  function addPage() {
    if (!isEditor() || state.step !== "plan") { return; }
    if (pages().length >= MAX_PAGES) { alert("ページ数の上限は " + MAX_PAGES + " ページです。"); return; }
    var page = composePage("", null, 0);
    var list = pages();
    insertAfterNode(page, list[list.length - 1] || null);
    afterPagesChanged();
    page.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* 紙面の順序だけを変更する。記事の計画と原稿はそのまま保持する。 */
  function changePage(page, action, source) {
    if (!isEditor() || state.step !== "plan") { return; }
    var list = pages(), index = list.indexOf(page);
    if (index < 0) { return; }
    if (action === "delete") {
      if (list.length <= MIN_PAGES) { return; }
      if (!confirm("p." + (index + 1) + " を削除します。\nこのページの原稿も消えます。記事の計画は残ります。")) { return; }
    } else if ((action === "previous" && index === 0) || (action === "next" && index === list.length - 1)) {
      return;
    }
    if (document.activeElement && document.activeElement.blur) { document.activeElement.blur(); }
    if (action === "delete") { page.remove(); }
    else if (action === "previous") { page.parentNode.insertBefore(page, list[index - 1]); }
    else { insertAfterNode(page, list[index + 1]); }
    afterPagesChanged();
    var target = action === "delete" ? pages()[Math.min(index, pages().length - 1)] : page;
    var scope = source === "paper" ? $(".page-tools", target)
      : $$('.page-order-card')[pages().indexOf(target)];
    if (scope) {
      var button = $('[data-page-action="' + action + '"]:not(:disabled)', scope)
        || $('button:not(:disabled)', scope);
      if (button) { button.focus({ preventScroll: true }); }
    }
  }

  function pageActions(page, source) {
    var index = pages().indexOf(page), count = pages().length;
    return el("div", { "class": "page-actions", "aria-label": "p." + (index + 1) + " の操作" }, [
      ["previous", "前に移動", index === 0],
      ["next", "後ろに移動", index === count - 1],
      ["delete", "削除", count <= MIN_PAGES]
    ].map(function (item) {
      return el("button", { type: "button", text: item[1], "data-page-action": item[0],
        "aria-label": "p." + (index + 1) + " を" + item[1],
        disabled: item[2] ? "disabled" : null,
        onclick: function () { changePage(page, item[0], source || "paper"); }
      });
    }));
  }

  function buildPageOrder() {
    var list = el("div", { "class": "page-order" }, [el("p", { "class": "panel-note",
      text: "ページにセクションを置き、その中に記事を配置します。ページは末尾に追加。移動は原稿を保持し、削除は計画を残します。" })]);
    pages().forEach(function (page, index) {
      var card = el("div", { "class": "page-order-card" }, [el("strong", { text: "p." + (index + 1) }), pageActions(page, "panel")]);
      $$(':scope > .page__body > [data-section]', page).forEach(function (node) {
        var section = sectionById(node.getAttribute("data-section"));
        if (!section) { return; }
        var titles = $$('[data-article]', node).map(function (block) {
          var a = articleById(block.getAttribute("data-article"));
          return a ? displayTitleOf(a) : "計画にない記事";
        });
        card.appendChild(el("div", { "class": "page-section-card", "data-section-card": section.id }, [
          el("strong", { text: "セクション：" + section.title }),
          el("div", { "class": "page-order-title", text: titles.join("／") || "記事はまだありません" }),
          buildArticleAssignment(page, section)
        ]));
      });
      card.appendChild(buildSectionAssignment(page));
      list.appendChild(card);
    });
    return list;
  }

  function buildSectionAssignment(page) {
    var choices = sections().filter(function (section) { return !sectionPages(section.id).length; });
    var pick = el("select", { "class": "page-tools__pick", "aria-label": "p." + pageNumberOf(page) + " に配置するセクション" },
      [el("option", { value: "", text: "配置するセクションを選ぶ" })].concat(choices.map(function (section) {
        return el("option", { value: section.id, text: section.title });
      }), sectionTemplates().map(function (t) {
        return el("option", { value: "template:" + t.id, text: "新しいセクション：" + t.label });
      })));
    var button = el("button", { type: "button", "class": "page-tools__add", text: "セクションを配置", disabled: "disabled",
      onclick: function () {
        var value = pick.value, section;
        if (value.indexOf("template:") === 0) {
          var id = value.slice(9);
          section = addSection({ template: id, title: sectionTemplateById(id).label });
        } else { section = sectionById(value); }
        if (!section || sectionPages(section.id).length) { return; }
        if (document.activeElement) { document.activeElement.blur(); }
        ensureSectionOnPage(page, section);
        afterPagesChanged();
        showBarToast("p." + pageNumberOf(page) + " に「" + section.title + "」セクションを配置しました");
      } });
    pick.addEventListener("change", function () { button.disabled = !pick.value; });
    return el("div", { "class": "page-assign" }, [pick, button]);
  }

  function buildArticleAssignment(page, section) {
    var placement = articlePlacement();
    var choices = articles().filter(function (a) { return section.articles.indexOf(a.id) >= 0 && !placement[a.id]; });
    var pick = el("select", { "class": "page-tools__pick", "aria-label": "p." + pageNumberOf(page) + " の「" + section.title + "」に配置する記事" },
      [el("option", { value: "", text: "配置する記事を選ぶ" })].concat(choices.map(function (a) {
        return el("option", { value: a.id, text: displayTitleOf(a) + "（" + articleTemplate(a).label + "）" });
      }), articleTemplates().map(function (t) {
        return el("option", { value: "template:" + t.id, text: "新しい記事：" + t.label });
      })));
    var button = el("button", { type: "button", "class": "page-tools__add", text: "記事を配置", disabled: "disabled",
      onclick: function () {
        var value = pick.value;
        if (value.indexOf("template:") === 0) { addArticleToPage(page, null, value.slice(9), section); }
        else if (value) { addArticleToPage(page, value, null, section); }
      } });
    pick.addEventListener("change", function () { button.disabled = !pick.value; });
    return el("div", { "class": "page-assign" }, [pick, button]);
  }

  function addArticleToPage(page, articleId, templateId, section) {
    if (!isEditor() || state.step !== "plan" || !section) { return; }
    if (articleId && (section.articles.indexOf(articleId) < 0 || articlePages(articleId).length)) { return; }
    if (document.activeElement) { document.activeElement.blur(); }
    var body = ensureSectionOnPage(page, section);
    var a = articleId ? articleById(articleId) : addArticle({ template: templateId || "free",
      title: templateById(templateId || "free").label + " " + (primaryArticles().length + 1) }, section);
    if (!a) { return; }
    var existing = $$('[data-article]', body);
    if (existing.length) {
      if (a.share === "rest") { a.share = 50; }
      var first = articleById(existing[0].getAttribute("data-article"));
      if (first && first.share === "rest") { first.share = 50; }
    }
    body.appendChild(articleHolder(a, 0, true));
    afterPagesChanged();
    showBarToast("「" + section.title + "」に「" + displayTitleOf(a) + "」を配置しました");
  }

  /* 入れ物ごと外す。中の原稿も一緒に消えるので必ず確認を取る。
     編集計画の側の記事は残す（別のページに置き直すことがあるため） */
  function removeArticleFromPage(block) {
    var id = block.getAttribute("data-article");
    var a = articleById(id);
    if (!confirm("このページから「" + (a ? displayTitleOf(a) : id) + "」の入れ物を外します。\n" +
                 "中に書いた原稿も一緒に消えます。\n編集計画の記事そのものは残ります。")) { return; }
    block.remove();
    afterPagesChanged();
  }

  /* ==========================================================================
     割合（決定 12）と続き（決定 13）
     ========================================================================== */

  /* 割合は meta が唯一の情報源。DOM（style="--share" / .article--rest）は導出した値。
     同じ記事が複数ページにあっても、全部へ同じ値を反映する */
  function applyShareToDOM(articleId, share) {
    var norm = normalizeShareValue(share);
    $$('.page [data-article="' + articleId + '"]').forEach(function (n) {
      if (!n.classList.contains("article--block")) { return; }
      n.removeAttribute("data-share");   /* 決定 11 の属性は廃止 */
      if (norm === "rest") {
        n.style.removeProperty("--share");
        n.classList.add("article--rest");
      } else {
        n.classList.remove("article--rest");
        n.style.setProperty("--share", norm + "%");
      }
      if (!n.getAttribute("style")) { n.removeAttribute("style"); }
    });
  }

  /* 記事1本ぶんの箱が自分の割当を越えて溢れている量（px）。「残り」は対象外 */
  function articleOverflowPx(node) {
    if (!node || node.classList.contains("article--rest")) { return 0; }
    return node.scrollHeight - node.clientHeight;
  }

  /* 親の末尾のブロックを1つ、続きの先頭へ。段落の途中では割らない。
     最低1つは親に残す */
  function sendBlockToContinuation(parentId, childId) {
    var p = articleNode(parentId), c = articleNode(childId);
    if (!p || !c || p.children.length <= 1) { return false; }
    c.insertBefore(p.lastElementChild, c.firstElementChild || null);
    return true;
  }

  function sendBlockFromContinuation(parentId, childId) {
    var p = articleNode(parentId), c = articleNode(childId);
    if (!p || !c || !c.firstElementChild) { return false; }
    p.appendChild(c.firstElementChild);
    return true;
  }

  /* 押したときだけ呼ばれる（読み込み時にも入力のたびにも走らせない）。
     親が溢れている間、ブロックを続きへ送り続ける。内容を減らす経路は作らない */
  function sendOverflowToContinuation(parentId, childId) {
    var p = articleNode(parentId), guard = 0;
    while (p && articleOverflowPx(p) > 2 && guard < 200) {
      if (!sendBlockToContinuation(parentId, childId)) { break; }
      guard++;
    }
    markDirty("issue");
    rerenderAll();
  }

  function pullBlockFromContinuation(parentId, childId) {
    sendBlockFromContinuation(parentId, childId);
    markDirty("issue");
    rerenderAll();
  }

  function buildContinuationButtons(parent, child) {
    var p = articleNode(parent.id), c = articleNode(child.id);
    if (!p || !c) { return []; }
    var btns = [];
    if (articleOverflowPx(p) > 2) {
      btns.push(el("button", {
        type: "button", "class": "frame-reflow",
        text: "溢れた分を続きへ送る（" + parent.title + " p." + pageNumberOf(p.closest(".page")) +
              "→p." + pageNumberOf(c.closest(".page")) + "）",
        title: "親の末尾のブロックを、溢れが収まるまで続きへ送ります。段落の途中では割りません。",
        onclick: function () { sendOverflowToContinuation(parent.id, child.id); }
      }));
    }
    if (c.children.length >= 1) {
      btns.push(el("button", {
        type: "button", "class": "frame-reflow frame-reflow--back",
        text: "続きから戻す（" + parent.title + " p." + pageNumberOf(c.closest(".page")) +
              "→p." + pageNumberOf(p.closest(".page")) + "）",
        title: "続きの先頭のブロックを1つ、親へ戻します。",
        onclick: function () { pullBlockFromContinuation(parent.id, child.id); }
      }));
    }
    return btns;
  }

  function refreshContinuationButtons() {
    $$(".continuation-controls").forEach(function (b) { b.remove(); });
    primaryArticles().forEach(function (parent) {
      var child = continuationOf(parent.id);
      if (!child || !canWrite(parent)) { return; }
      if (focusOwner() !== null && (parent.owner || "") !== focusOwner()) { return; }
      var btns = buildContinuationButtons(parent, child);
      if (!btns.length) { return; }
      var page = articleNode(parent.id).closest(".page");
      page.appendChild(el("div", { "class": "continuation-controls" }, btns));
    });
  }

  /* --- 紙面での境目ドラッグ（「細かく調整」の一部） ------------------------- */

  function zoomFactor() {
    var z = parseFloat(getComputedStyle(document.body).getPropertyValue("--zoom"));
    return (!isNaN(z) && z > 0) ? z : 1;
  }

  /* offsetTop/offsetHeight は transform: scale() の影響を受けないレイアウト寸法 */
  function positionShareHandle(handle, page, aboveEl) {
    var rect = aboveEl.getBoundingClientRect(), pageRect = page.getBoundingClientRect();
    handle.style.top = (rect.bottom - pageRect.top) / zoomFactor() + "px";
  }

  function attachShareDrag(handle, page, elA, elB) {
    handle.addEventListener("mousedown", function (ev) {
      ev.preventDefault();
      var body = $(".page__body", page);
      var artA = articleById(elA.getAttribute("data-article"));
      var artB = articleById(elB.getAttribute("data-article"));
      if (!body || !artA || !artB) { return; }
      var totalH = elA.parentElement.clientHeight || body.clientHeight, zoom = zoomFactor(), startY = ev.clientY;
      var startA = artA.share === "rest" ? null : artA.share;
      var startB = artB.share === "rest" ? null : artB.share;
      var sum = (startA !== null && startB !== null) ? startA + startB : null;

      function onMove(e2) {
        var deltaPct = Math.round(((e2.clientY - startY) / zoom / totalH) * 100 / 5) * 5;
        if (startA !== null && startB !== null) {
          /* 両方が数値のときだけ、合計を保ったまま境目を動かす */
          var a = Math.max(0, Math.min(sum, clampShare(startA + deltaPct)));
          artA.share = a; artB.share = sum - a;
        } else if (startA === null && startB !== null) {
          artB.share = clampShare(startB - deltaPct);   /* 上が「残り」 */
        } else if (startB === null && startA !== null) {
          artA.share = clampShare(startA + deltaPct);   /* 下が「残り」 */
        } else {
          return;   /* 両方とも「残り」。相手のいないドラッグは受け付けない */
        }
        applyShareToDOM(artA.id, artA.share);
        applyShareToDOM(artB.id, artB.share);
        positionShareHandle(handle, page, elA);
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        rerenderAll();
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  function renderShareHandles() {
    $$(".share-handle").forEach(function (h) { h.remove(); });
    /* 割合は台割の一部なので、計画の工程で編集長だけが動かせる */
    if (!isEditor() || state.step !== "plan" || document.body.getAttribute("data-view") === "plan") { return; }
    pages().forEach(function (page) {
      var body = $(".page__body", page);
      if (!body) { return; }
      $$("[data-section-articles]", body).forEach(function (slot) {
        if (slot.parentElement.getAttribute("data-layout") === "columns") { return; }
        var blocks = $$(":scope > .article--block[data-article]", slot);
        for (var i = 0; i < blocks.length - 1; i++) {
          var handle = el("div", { "class": "share-handle", title: "ドラッグして境目を動かす（5%刻み）" });
          positionShareHandle(handle, page, blocks[i]);
          attachShareDrag(handle, page, blocks[i], blocks[i + 1]);
          page.appendChild(handle);
        }
      });
    });
  }

  /* ==========================================================================
     検査（機械が見たもの）
     ========================================================================== */

  var findings = [];

  function checkAll() {
    findings = [];
    checkPlan();
    checkOverflow();
    refreshContinuationButtons();
    checkContinuations();
    checkShares();
    checkAccessibility();
    renderChecks();
    renderToc();
    return findings;
  }

  /* 編集計画と紙面の食い違い。ここが通っていないと、担当も締切も紙面に反映されない */
  function checkPlan() {
    var placement = articlePlacement();
    var planned = plannedTotal();
    var total = pages().length;

    if (planned !== total) {
      findings.push({ level: "warn", message: "予定 " + planned + " ページに対し、実際は " + total + " ページです" });
    }
    if (!primaryArticles().length) {
      findings.push({ level: "error", message: "編集計画に記事が 1 本も登録されていません" });
    }

    primaryArticles().forEach(function (a) {
      if (!a.owner) {
        findings.push({ level: "error", message: "「" + a.title + "」に担当者が割り当てられていません" });
      } else if (!state.setupMode && !state.meta.released && !memberByName(a.owner)) {
        /* 発行済みの号は督促しない。過去号の担当者が名簿から抜けているのは普通のこと */
        findings.push({ level: "warn", message: "「" + a.title + "」の担当者「" + a.owner + "」が名簿にありません（本人がログインしても自分の記事になりません）" });
      }
      if (!mergedPlacement(a.id, placement)) {
        findings.push({ level: "warn", message: "「" + a.title + "」が紙面に配置されていません" });
      }
      if (!state.meta.released) {
        var cur = currentOf(a), due = dueOf(a, cur);
        if (cur !== "signoff" && due && due < todayISO()) {
          var st = STAGES.find(function (s) { return s.id === cur; });
          findings.push({ level: "warn", message: "「" + a.title + "」の" + (st ? st.label : cur) + "が期日（" + due + "）を過ぎています" });
        }
      }
    });

    /* 決定 1: 入校日を過ぎたのに校了していない記事 */
    var finalDue = state.meta.schedule[FINAL_STAGE_ID];
    if (!state.meta.released && finalDue && finalDue < todayISO()) {
      var sc = signoffCount();
      if (sc.done < sc.total) {
        findings.push({ level: "error", message: "入校日（" + finalDue + "）を過ぎていますが、校了していない記事が " + (sc.total - sc.done) + " 本あります" });
      }
    }

    Object.keys(placement).forEach(function (id) {
      if (!articleById(id)) {
        findings.push({ level: "error",
          message: "紙面の data-article=\"" + id + "\" が編集計画にありません（" + placementLabel(placement[id]) + "）" });
      }
    });

    pages().forEach(function (page, i) {
      if (!$("[data-article]", page)) {
        findings.push({ level: "warn", message: "p." + (i + 1) + " にどの記事も割り当てられていません", node: page });
      }
    });

    var membership = {};
    sections().forEach(function (section) {
      if (!findTemplateRaw(section.template, "section")) {
        findings.push({ level: "error", message: "セクション「" + section.title + "」のテンプレート「" + section.template + "」は存在しません" });
      }
      section.articles.forEach(function (id) {
        if (!articleById(id)) { findings.push({ level: "error", message: "セクション「" + section.title + "」の記事「" + id + "」が計画にありません" }); }
        if (membership[id]) { findings.push({ level: "error", message: "記事「" + id + "」が複数のセクションに所属しています" }); }
        membership[id] = section.id;
      });
    });
    pages().forEach(function (page, index) {
      $$('[data-section]', page).forEach(function (node) {
        var id = node.getAttribute("data-section");
        if (!sectionById(id)) { findings.push({ level: "error", node: node, message: "p." + (index + 1) + " のセクション「" + id + "」が計画にありません" }); }
        $$('[data-article]', node).forEach(function (article) {
          var articleId = article.getAttribute("data-article");
          if (membership[articleId] && membership[articleId] !== id) { findings.push({ level: "error", node: article, message: "記事「" + articleId + "」の所属セクションと紙面が一致しません" }); }
        });
      });
    });

    var onceCounts = {};
    primaryArticles().forEach(function (a) {
      var t = articleTemplate(a), pl = mergedPlacement(a.id, placement);
      if (a.template && !findTemplateRaw(a.template)) {
        findings.push({ level: "error", message: "「" + a.title + "」の記事テンプレート「" + a.template +
          "」は存在しません（「自由」として扱っています。計画で選び直してください）" });
      }
      if (t.once) { onceCounts[t.id] = (onceCounts[t.id] || 0) + 1; }
      if (t.fixed === "first" && pl && pl.first !== 1) {
        findings.push({ level: "warn", message: "「" + a.title + "」は先頭に置く記事（" + t.label +
          "）ですが、p.1 にありません（現在 " + placementLabel(pl) + "）" });
      }
    });
    effectiveSections().forEach(function (f) {
      var pl = null;
      (f.articles || []).forEach(function (id) {
        var p = placement[id];
        if (!p) { return; }
        pl = pl ? { first: Math.min(pl.first, p.first), last: Math.max(pl.last, p.last), pages: pl.pages.concat(p.pages) } : p;
      });
      if (pl) {
        var used = pl.pages.filter(function (v, i, arr) { return arr.indexOf(v) === i; }).length;
        var plannedPages = sectionPlannedPages(f);
        if (plannedPages > 0 && used > plannedPages) {
          findings.push({ level: "warn",
            message: "「" + f.title + "」は計画の占有ページ数（" + plannedPages + "）より多い " + used + " ページが紙面にあります" });
        }
      }
      if (!(f.articles || []).length) {
        findings.push({ level: "warn", message: "セクション「" + f.title + "」に記事が 1 本も入っていません" });
      }
    });
    Object.keys(onceCounts).forEach(function (id) {
      if (onceCounts[id] >= 2) {
        findings.push({ level: "error",
          message: "「" + templateById(id).label + "」の記事テンプレートが " + onceCounts[id] + " か所で使われています（1 号に 1 つだけの指定です）" });
      }
    });

    /* 末尾固定（奥付・裏表紙）は、複数あってよいが号の最後にまとまっていること */
    var lastPages = [];
    primaryArticles().forEach(function (a) {
      if (articleTemplate(a).fixed !== "last") { return; }
      var pl = mergedPlacement(a.id, placement);
      (pl ? pl.pages : []).forEach(function (p) { if (lastPages.indexOf(p) < 0) { lastPages.push(p); } });
    });
    if (lastPages.length) {
      lastPages.sort(function (x, y) { return x - y; });
      if (lastPages[0] !== total - lastPages.length + 1 || lastPages[lastPages.length - 1] !== total) {
        findings.push({ level: "warn", message: "末尾固定の記事テンプレート（奥付・裏表紙など）が号の末尾にまとまっていません" });
      }
    }

    if (total > 0 && total % 4 !== 0) {
      findings.push({ level: "warn",
        message: "総ページ数が " + total + " ページです。中綴じ製本の場合は 4 の倍数である必要があります" });
    }
  }

  /* 版面から溢れた内容は印刷時に切り落とされる。.page は overflow:hidden なので
     目視では気づけない。必ず機械で見る。
     縦だけでなく横も測る（決定 9）。2 段組の本文が溢れると続きは「3 段目」として
     右横に流れ、ページの高さは 1mm も増えない。紙には一字も出ない最も危ない溢れ方 */
  function checkOverflow() {
    pages().forEach(function (page, i) {
      var body = $(".page__body", page);
      if (!body) { return; }
      var overY = Math.max(body.scrollHeight - body.clientHeight, page.scrollHeight - page.clientHeight);
      var overX = page.scrollWidth - page.clientWidth;
      if (overY > 2 || overX > 2) {   /* 2px は丸め誤差の許容 */
        var mmY = Math.round(overY / 3.78), mmX = Math.round(overX / 3.78);
        page.setAttribute("data-overflow", "true");
        page.setAttribute("data-overflow-label", overX > 2
          ? "本文が段組の外へ約 " + mmX + "mm（紙に出ません）"
          : "版面から約 " + mmY + "mm 溢れています");
        findings.push({ level: "error", node: page, message: overX > 2
          ? "p." + (i + 1) + " の本文が段組の外へ溢れています（約 " + mmX + "mm ぶん。紙には一字も出ません）"
          : "p." + (i + 1) + " の内容が版面から約 " + mmY + "mm 溢れています" });
        return;
      }

      /* 記事単位の溢れ（決定 12）。割合を持つ記事は「その割合ぶんの箱」なので、
         ページが溢れていなくても割当を越えていれば隣の記事の場所に食い込んでいる */
      var worst = null;
      $$(".article--block", page).forEach(function (art) {
        var over = articleOverflowPx(art);
        if (over > 2 && (!worst || over > worst.over)) { worst = { over: over, node: art }; }
      });
      if (worst) {
        var label = displayTitleOf(articleById(worst.node.getAttribute("data-article")));
        var share = worst.node.style.getPropertyValue("--share").trim();
        var text = "「" + label + "」が割当" + (share ? "（" + share + "）" : "") + "を約 " + Math.round(worst.over / 3.78) + "mm 超えています";
        page.setAttribute("data-overflow", "true");
        page.setAttribute("data-overflow-label", text);
        findings.push({ level: "error", node: worst.node, message: "p." + (i + 1) + " の" + text });
        return;
      }
      page.removeAttribute("data-overflow");
      page.removeAttribute("data-overflow-label");
    });
  }

  /* 決定 13: 続きの整合性 */
  function checkContinuations() {
    var placement = articlePlacement();
    articles().forEach(function (a) {
      if (!a.continues) { return; }
      var parent = articleById(a.continues);
      if (!parent) {
        findings.push({ level: "error", message: "続き「" + a.id + "」の親「" + a.continues + "」が編集計画にありません" });
        return;
      }
      var childPl = placement[a.id], parentPl = placement[parent.id];
      if (childPl && parentPl && childPl.first < parentPl.last) {
        findings.push({ level: "error",
          message: "続き「" + a.id + "」（" + placementLabel(childPl) + "）が親「" + parent.title + "」（" + placementLabel(parentPl) + "）より前のページにあります" });
      }
      if (a.owner || (a.schedule && Object.keys(a.schedule).length)) {
        findings.push({ level: "warn", message: "続き「" + a.id + "」に担当者や締切が書かれています（親から引くため使われません）" });
      }
      if (!parentPl && childPl) {
        findings.push({ level: "warn", message: "親「" + parent.title + "」が紙面に無いのに、続き「" + a.id + "」だけが紙面にあります" });
      }
      /* 空の続きは紙面では割合ぶんの白い穴になる。全部戻した直後は普通に起きるので warn */
      var box = articleNode(a.id);
      if (box && !box.children.length) {
        findings.push({ level: "warn", node: box,
          message: displayTitleOf(a) + "の入れ物が空のまま場所を占めています（紙には空白が出ます）" });
      }
    });
  }

  /* 決定 12: 同じページの割合の合計を 100% 基準で見る（許容 ±2%） */
  function checkShares() {
    pages().forEach(function (page, i) {
      $$("[data-section-articles]", page).forEach(function (slot) {
        if (slot.parentElement.getAttribute("data-layout") === "columns") { return; }
        var seen = {}, restCount = 0, sum = 0, any = false;
        $$(":scope > .article--block[data-article]", slot).forEach(function (node) {
          var id = node.getAttribute("data-article"), a = articleById(id);
          if (seen[id] || !a) { return; }
          seen[id] = true; any = true;
          if (a.share === "rest") { restCount++; } else { sum += shareToNumber(a.share); }
        });
        if (!any) { return; }
        var pct = Math.round(sum * 100);
        if (pct > 102 || (pct < 98 && !restCount)) {
          findings.push({ level: "warn", message: "p." + (i + 1) + " のセクション内の記事の割合の合計が 100% " +
            (pct > 102 ? "を超えています" : "に足りていません") + "（合計 " + pct + "%）" });
        }
        if (restCount >= 2) { findings.push({ level: "warn", message: "p." + (i + 1) + " の同じセクションに「残り」の記事が " + restCount + " 本あります" }); }
      });
    });
  }

  function checkAccessibility() {
    /* 代替テキスト。装飾目的なら alt="" を明示させる（属性ごと無いのは不可） */
    $$(".page img").forEach(function (img) {
      if (!img.closest(".settings-view") && !img.hasAttribute("alt")) {
        findings.push({ level: "error", node: img,
          message: "画像に alt 属性がありません（" + (img.getAttribute("src") || "?") + "）" });
      }
    });

    pages().forEach(function (page) {
      $$("p, li, td", page).forEach(function (node) {
        if (node.closest(".production-slug, .page-tools")) { return; }
        var pt = parseFloat(getComputedStyle(node).fontSize) * 72 / 96;
        if (pt < 8) {
          findings.push({ level: "warn", node: node,
            message: "文字が小さすぎます（" + pt.toFixed(1) + "pt）: " + (node.textContent || "").trim().slice(0, 18) });
        }
      });
      $$(".t-band, .box, .callout, .production-slug", page).forEach(function (node) {
        if (node.classList.contains("production-slug") && document.body.getAttribute("data-proof") !== "on") { return; }
        var ratio = contrastOf(node);
        if (ratio !== null && ratio < 4.5) {
          findings.push({ level: ratio < 3 ? "error" : "warn", node: node,
            message: "コントラスト比 " + ratio.toFixed(1) + ":1（4.5:1 未満）: ." + node.className.split(" ")[0] });
        }
      });
    });

    var levels = [];
    pages().forEach(function (page) {
      $$("h1, h2, h3, h4", page).forEach(function (h) { levels.push(parseInt(h.tagName.slice(1), 10)); });
    });
    for (var i = 1; i < levels.length; i++) {
      if (levels[i] - levels[i - 1] > 1) {
        findings.push({ level: "warn", message: "見出しレベルが h" + levels[i - 1] + " から h" + levels[i] + " に飛んでいます" });
        break;
      }
    }
  }

  function contrastOf(node) {
    var fg = parseColor(getComputedStyle(node).color);
    var bg = effectiveBackground(node);
    if (!fg || !bg) { return null; }
    var l1 = luminance(fg), l2 = luminance(bg);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  function effectiveBackground(node) {
    var cur = node;
    while (cur && cur !== document.documentElement) {
      var c = parseColor(getComputedStyle(cur).backgroundColor);
      if (c && c.a > 0.9) { return c; }
      if (cur.classList && cur.classList.contains("page")) { break; }
      cur = cur.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };   /* 最後は紙の白 */
  }

  function parseColor(str) {
    var m = /rgba?\(([^)]+)\)/.exec(str || "");
    if (!m) { return null; }
    var p = m[1].split(",").map(function (v) { return parseFloat(v); });
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }

  function luminance(c) {
    var ch = [c.r, c.g, c.b].map(function (v) {
      v = v / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }

  function renderChecks() {
    var list = $("#kaiho-checks");
    if (list) {
      list.innerHTML = "";
      if (!findings.length) {
        list.appendChild(el("li", { "data-level": "ok", text: "指摘はありません" }));
      }
      findings.forEach(function (f) {
        list.appendChild(el("li", { "data-level": f.level }, [
          el(f.node ? "button" : "span", { type: f.node ? "button" : null,
            text: (f.level === "error" ? "［入稿を止める］" : "［判断する］") + f.message,
            onclick: function () { if (f.node) { revealPaperNode(f.node); } } })
        ]));
      });
    }
    var badge = $("#kaiho-checkbadge");
    if (badge) {
      var errors = findings.filter(function (f) { return f.level === "error"; }).length;
      var warns = findings.length - errors;
      badge.textContent = "検査 " + errors + " / ⚠ " + warns;
      badge.setAttribute("data-alert", errors ? "true" : "false");
    }
  }

  /* ==========================================================================
     役割と書ける範囲（決定 14）
     ========================================================================== */

  function role() { return state.viewer ? state.viewer.role : "viewer"; }
  function isEditor() { return role() === "editor"; }

  function ownsArticle(a) {
    var p = ownerArticle(a);
    return !!(p && state.viewer && p.owner && p.owner === state.viewer.name);
  }

  /* 本文を書けるのは編集長と、その記事の担当者だけ。
     工程が「原稿作成」「校正」のときに限る（計画・入稿の間は誰も書かない） */
  function canWrite(a) {
    if (state.step !== "write" && state.step !== "proof") { return false; }
    return isEditor() || (role() === "staff" && ownsArticle(a));
  }
  function canAdvance(a) { return isEditor() || (role() === "staff" && ownsArticle(a)); }
  function canComment() { return role() !== "viewer"; }

  /* data-editable が付いた要素だけを開く。記事に属さない柱などは編集長だけ */
  function applyEditMode() {
    var any = false;
    pages().forEach(function (page) {
      $$("[data-editable]", page).forEach(function (node) {
        var host = node.closest("[data-article]");
        var a = host ? articleById(host.getAttribute("data-article")) : null;
        var on = a ? canWrite(a)
                   : (isEditor() && (state.step === "write" || state.step === "proof"));
        /* 決定 15: 伏せた記事は書けなくする */
        if (node.closest('[data-focus="other"]')) { on = false; }
        if (on) {
          any = true;
          node.setAttribute("contenteditable", "true");
          node.addEventListener("paste", onPaste);
          node.addEventListener("input", onInput);
        } else {
          node.removeAttribute("contenteditable");
          node.removeEventListener("paste", onPaste);
          node.removeEventListener("input", onInput);
        }
      });
    });
    if (any) { document.body.setAttribute("data-mode", "edit"); }
    else { document.body.removeAttribute("data-mode"); }
  }

  function onPaste(ev) {
    /* 書式付き貼り付けは体裁を壊すので、常に平文に落とす */
    ev.preventDefault();
    var text = (ev.clipboardData || window.clipboardData).getData("text/plain");
    document.execCommand("insertText", false, text);
  }

  var inputTimer = null;
  function onInput(ev) {
    var title = ev && ev.target.closest("[data-section-title]");
    if (title) {
      var host = title.closest("[data-section]"), section = host && sectionById(host.getAttribute("data-section"));
      if (section) { section.title = title.textContent; syncSectionTitle(section); syncMeta(); }
    }
    markDirty("issue");
    clearTimeout(inputTimer);
    inputTimer = setTimeout(function () { checkAll(); updateStatusBits(); }, 400);
  }

  /* ==========================================================================
     決定 15: 担当で絞る（原稿作成で、他の担当の記事をグレーアウト）
     --------------------------------------------------------------------------
     - 原稿作成で、ログイン中の人が担当者 → 自動でその人に絞る
     - 編集長 → パネルの「表示」で全員／担当者ごとを切り替える
     - 閲覧者・ほかの工程 → 絞らない
     隠さずにグレーアウトする理由は docs/00 決定 15（ノンブルと左右／隣の記事の
     割合／溢れ検査）。見え方であって権限ではない。
     ========================================================================== */

  function ownerOfArticleId(id) {
    var a = articleById(id);
    if (!a) { return null; }
    var p = ownerArticle(a);
    return p === a && a.continues ? null : (p.owner || "");
  }

  function focusOwner() {
    if (state.step !== "write") { return null; }
    if (role() === "staff") { return state.viewer.name; }
    if (isEditor()) { return state.editorFocus; }
    return null;
  }

  function ownerChoices() {
    var names = [], hasUnassigned = false;
    primaryArticles().forEach(function (a) {
      if (!a.owner) { hasUnassigned = true; return; }
      if (names.indexOf(a.owner) < 0) { names.push(a.owner); }
    });
    return { names: names, hasUnassigned: hasUnassigned };
  }

  function focusAttrOf(articleId) {
    var f = focusOwner();
    if (f === null) { return null; }
    return ownerOfArticleId(articleId) === f ? "mine" : "other";
  }

  function otherOwnersLabel(page) {
    var names = [];
    $$("[data-article]", page).forEach(function (n) {
      var o = ownerOfArticleId(n.getAttribute("data-article"));
      var label = o === null ? "計画に無い記事" : (o || "担当未設定");
      if (names.indexOf(label) < 0) { names.push(label); }
    });
    return names.length ? names.join("・") : "記事なし";
  }

  function applyFocus() {
    var f = focusOwner();
    var on = f !== null;
    if (on) { document.body.setAttribute("data-focus", "on"); }
    else { document.body.removeAttribute("data-focus"); }

    pages().forEach(function (page) {
      var veil = $(".focus-veil", page);
      if (veil) { veil.remove(); }
      var mine = false;
      $$("[data-article]", page).forEach(function (node) {
        if (!on) { node.removeAttribute("data-focus"); return; }
        var m = ownerOfArticleId(node.getAttribute("data-article")) === f;
        node.setAttribute("data-focus", m ? "mine" : "other");
        if (m) { mine = true; }
      });
      if (!on) { page.removeAttribute("data-focus"); return; }
      page.setAttribute("data-focus", mine ? "mine" : "other");
      if (!mine) {
        page.appendChild(el("div", { "class": "focus-veil", "aria-hidden": "true" }, [
          el("span", { "class": "focus-veil__label", text: "他の担当のページ（" + otherOwnersLabel(page) + "）" })
        ]));
      }
    });
    applyEditMode();
  }

  function scrollToFirstFocused() {
    var first = pages().find(function (p) { return p.getAttribute("data-focus") === "mine"; });
    if (!first) { return; }
    var barH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--bar-h")) || 44;
    window.scrollTo({ top: first.getBoundingClientRect().top + window.scrollY - barH - 32, behavior: "smooth" });
  }

  function buildFocusSelect() {
    var c = ownerChoices();
    if (state.editorFocus && c.names.indexOf(state.editorFocus) < 0) { state.editorFocus = null; }
    if (state.editorFocus === "" && !c.hasUnassigned) { state.editorFocus = null; }
    var cur = state.editorFocus === null ? "__all__" : (state.editorFocus === "" ? "__none__" : state.editorFocus);
    var opts = [{ v: "__all__", t: "全員" }].concat(
      c.names.map(function (n) { return { v: n, t: "担当: " + n }; }),
      c.hasUnassigned ? [{ v: "__none__", t: "担当: 未設定の記事" }] : []);
    var sel = el("select", {
      "data-active": state.editorFocus === null ? "false" : "true",
      onchange: function () {
        var v = this.value;
        state.editorFocus = v === "__all__" ? null : (v === "__none__" ? "" : v);
        rerenderAll();
        if (state.editorFocus !== null) { scrollToFirstFocused(); }
      }
    }, opts.map(function (o) {
      return el("option", { value: o.v, text: o.t, selected: o.v === cur ? "selected" : null });
    }));
    return el("label", { "class": "focus-pick", text: "表示" }, [sel]);
  }

  /* ==========================================================================
     号の工程（決定 14）
     ========================================================================== */

  /* 今いるべき工程。号の状態から導く。導出値なので保存しない */
  function suggestedStep() {
    if (state.meta.released) { return "release"; }
    var prim = primaryArticles();
    if (!prim.length || prim.some(function (a) { return !a.owner; }) || plannedTotal() !== pages().length) { return "plan"; }
    if (prim.some(function (a) { return currentOf(a) === "manuscript"; })) { return "write"; }
    var sc = signoffCount();
    return sc.done < sc.total ? "proof" : "release";
  }

  function stepProgress(id) {
    var prim = primaryArticles();
    if (id === "plan") {
      var missing = prim.filter(function (a) { return !a.owner; }).length;
      var gap = plannedTotal() - pages().length;
      if (!missing && gap === 0 && prim.length) { return { text: "確定", done: true }; }
      return { text: missing ? "担当未定 " + missing : "頁 " + pages().length + "/" + plannedTotal(), done: false };
    }
    if (id === "write") {
      var n = prim.filter(function (a) { return state.meta.released || currentOf(a) !== "manuscript"; }).length;
      return { text: "原稿 " + n + "/" + prim.length, done: prim.length > 0 && n === prim.length };
    }
    if (id === "proof") {
      var sc = signoffCount();
      return { text: "校了 " + sc.done + "/" + sc.total, done: sc.total > 0 && sc.done === sc.total };
    }
    return { text: state.meta.released ? "発行済み" : "未", done: !!state.meta.released };
  }

  /* 工程を切り替えると、紙面の見え方も揃える。刷り分けの3種類
     （台割シート／校正紙／入稿データ）が、計画・校正・入稿の出口に対応する */
  function setStep(id) {
    state.step = id;
    document.body.setAttribute("data-step", id);
    if (id === "plan") { document.body.setAttribute("data-view", "plan"); }
    else { document.body.removeAttribute("data-view"); }
    if (id === "proof") { document.body.setAttribute("data-proof", "on"); }
    else { document.body.removeAttribute("data-proof"); }
    if (id === "release") { document.body.removeAttribute("data-guides"); }
    rerenderAll();
    setMobileSurface("tasks");
    updateFitZoom();
    if (id === "write" && focusOwner() !== null) { scrollToFirstFocused(); }
  }

  /* ==========================================================================
     校正コメント（号の隣の comments.js。docs/09 §3.1 により meta には入れない）
     ========================================================================== */

  function readComments() {
    var list = window.KAIHO_COMMENTS;
    return Array.isArray(list) ? JSON.parse(JSON.stringify(list)) : [];
  }

  function commentsOf(articleId) { return state.comments.filter(function (c) { return c.article === articleId; }); }
  function openCommentCount(articleId) {
    return commentsOf(articleId).filter(function (c) { return !c.resolved; }).length;
  }
  function canResolve(c) { return isEditor() || (canComment() && state.viewer && c.author === state.viewer.name); }

  /* 紙面で文字を選ぶと、その記事への引用として控える。
     テキスト欄をクリックした瞬間に選択は消えるので、選んだ時点で控える */
  function captureSelection() {
    if (state.step !== "proof" || !canComment()) { return; }
    var sel = window.getSelection();
    var text = sel ? String(sel).trim() : "";
    if (!text || !sel.anchorNode) { return; }
    var node = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentNode;
    var art = node && node.closest && node.closest(".page [data-article]");
    if (!art) { return; }
    var a = ownerArticle(articleById(art.getAttribute("data-article")));
    if (!a) { return; }
    if (state.quote && state.quote.article === a.id && state.quote.text === text.slice(0, 80)) { return; }
    state.quote = { article: a.id, text: text.slice(0, 80) };
    renderPanel();
  }

  /* ==========================================================================
     パネル（いまの工程の中身だけを出す）
     ========================================================================== */

  function field(label, value, onchange, type) {
    return el("label", { text: label }, [
      el("input", { type: type || "text", value: value || "", oninput: function () { onchange(this.value); } })
    ]);
  }

  function setPanelWidth(px) {
    var w = Math.max(PANEL_MIN, Math.min(PANEL_MAX, Math.round(px)));
    document.documentElement.style.setProperty("--panel-w", w + "px");
    updateFitZoom();
    return w;
  }

  function buildResizer() {
    var grip = el("div", {
      "class": "editor-panel__resizer", role: "separator",
      "aria-orientation": "vertical", "aria-label": "パネルの幅", tabindex: "0"
    });
    grip.addEventListener("pointerdown", function (ev) {
      ev.preventDefault();
      grip.setPointerCapture(ev.pointerId);
      document.body.setAttribute("data-resizing", "true");
      function move(e) { setPanelWidth(window.innerWidth - e.clientX); }
      function up(e) {
        grip.releasePointerCapture(e.pointerId);
        document.body.removeAttribute("data-resizing");
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
      }
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
    });
    /* キーボードでも動かせないと、マウスを使わない人が担当者列を出せない */
    grip.addEventListener("keydown", function (ev) {
      var cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--panel-w"), 10) || PANEL_MIN;
      if (ev.key === "ArrowLeft") { ev.preventDefault(); setPanelWidth(cur + 20); }
      else if (ev.key === "ArrowRight") { ev.preventDefault(); setPanelWidth(cur - 20); }
    });
    return grip;
  }

  function buildPanel() {
    var panel = el("aside", { id: "kaiho-panel", "class": "editor-panel", "data-open": "true", "aria-label": "作業内容" });
    panel.appendChild(buildResizer());
    panel.appendChild(el("div", { "class": "editor-panel__content", id: "kaiho-panel-content" }));
    panel.appendChild(el("div", { "class": "editor-panel__exit", id: "kaiho-panel-exit" }));
    document.body.appendChild(panel);
    return panel;
  }

  function section(title, open, children, id) {
    var d = el("details", { "class": "panel-section", id: id || null, open: open ? "open" : null }, [
      el("summary", { text: title })
    ]);
    (children || []).forEach(function (c) { if (c) { d.appendChild(c); } });
    return d;
  }

  /* 権限の無い人には同じ画面を「読むだけ」で見せる（閲覧は全員できる、docs/09 §2） */
  function makeReadOnly(container) {
    $$("input, select, textarea, button", container).forEach(function (n) {
      if (n.closest("[data-keep-enabled]")) { return; }
      n.disabled = true;
    });
    container.setAttribute("data-readonly", "true");
  }

  function lockNote(text) { return el("p", { "class": "panel-lock", text: text }); }

  function nextBox(items) {
    var box = el("div", { "class": "next-box" }, [el("div", { "class": "next-box__label", text: "次にやること" })]);
    if (!items.length) {
      box.appendChild(el("p", { "class": "next-box__item", "data-level": "ok", text: "いまやることはありません" }));
    }
    items.slice(0, 3).forEach(function (it) {
      box.appendChild(el(it.node || it.action ? "button" : "p", {
        type: it.node || it.action ? "button" : null,
        "class": "next-box__item", "data-level": it.level || "todo", text: it.text,
        "data-link": it.node || it.action ? "true" : null,
        onclick: it.action || (it.node ? function () { revealPaperNode(it.node); } : null)
      }));
    });
    if (items.length > 3) {
      box.appendChild(el("p", { "class": "next-box__more", text: "ほか " + (items.length - 3) + " 件" }));
    }
    return box;
  }

  function renderPanel() {
    var panel = $(".editor-panel") || buildPanel();
    var content = $("#kaiho-panel-content", panel);
    var exit = $("#kaiho-panel-exit", panel);
    /* 入力中の欄は作り直さない（1文字ごとにフォーカスが飛ぶ） */
    if (content.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) { return; }
    var openSections = {};
    $$("details.panel-section[id]", content).forEach(function (d) { openSections[d.id] = d.open; });
    var scroll = content.scrollTop;
    content.innerHTML = "";
    exit.innerHTML = "";

    var step = STEPS.find(function (s) { return s.id === state.step; });
    content.appendChild(el("div", { "class": "panel-head" }, [
      el("h1", { text: step.label }),
      el("span", { "class": "panel-head__who", text: "おもに" + step.who + "の作業" })
    ]));
    content.appendChild(el("p", { "class": "step-help", text: role() === "viewer" ?
      "読むための画面です。記事や進み具合を確認できます。編集が必要なときは担当者に伝えてください。" : STEP_HELP[state.step] }));

    ({ plan: buildPlanStep, write: buildWriteStep, proof: buildProofStep, release: buildReleaseStep })[state.step](content, exit);

    content.appendChild(section("検査（機械が見たもの）", false, [
      el("ul", { id: "kaiho-checks", "class": "check-list" }),
      el("p", { "class": "panel-note",
        text: "［入稿を止める］は直してから入稿するもの、［判断する］は事情があれば残してよいものです。" })
    ], "sec-checks"));
    if (role() !== "viewer") {
      content.appendChild(el("p", { "class": "panel-note save-help", text: window.showDirectoryPicker ?
        "変更は自動保存されません。上の「保存」を押してください。初回は作業フォルダを選びます。" :
        "変更は自動保存されません。「保存」でファイルをダウンロードし、元のファイルと置き換えてください。" }));
    }

    $$("details.panel-section[id]", content).forEach(function (d) {
      if (d.hasAttribute("data-force-open")) { d.open = true; return; }
      if (openSections.hasOwnProperty(d.id)) { d.open = openSections[d.id]; }
    });
    content.scrollTop = scroll;
    renderChecks();
  }

  /* ---- 計画 --------------------------------------------------------------- */

  function buildPlanStep(content, exit) {
    var items = [];
    if (isEditor()) {
      primaryArticles().forEach(function (a) {
        if (!a.owner) { items.push({ level: "error", text: "「" + a.title + "」の担当者を決める", action: function () {
          var section = $("#sec-plan");
          if (section) { section.open = true; }
          var pick = $$("[data-owner-for]").find(function (n) { return n.getAttribute("data-owner-for") === a.id; });
          if (pick) { pick.scrollIntoView({ block: "center" }); pick.focus({ preventScroll: true }); }
        } }); }
      });
      var gap = plannedTotal() - pages().length;
      if (gap > 0) { items.push({ text: "紙面が " + gap + " ページ足りません。「不足しているページを作る」で揃える" }); }
      if (gap < 0) { items.push({ level: "warn", text: "紙面が計画より " + (-gap) + " ページ多い。不要なページを確かめる" }); }
      if (!items.length) { items.push({ text: "台割シートを印刷して企画会議で配る" }); }
    }
    content.appendChild(isEditor() ? nextBox(items)
      : lockNote("計画は編集長が決めます。ここでは読むだけです。自分の担当と締切は台割シートで確かめられます。"));

    var isSheet = document.body.getAttribute("data-view") === "plan";
    var view = el("div", { "class": "seg", "data-keep-enabled": "true" }, [
      el("button", { type: "button", text: "台割シート", "aria-pressed": isSheet ? "true" : "false",
        onclick: function () { document.body.setAttribute("data-view", "plan"); rerenderAll(); } }),
      el("button", { type: "button", text: "紙面", "aria-pressed": isSheet ? "false" : "true",
        onclick: function () { document.body.removeAttribute("data-view"); rerenderAll(); } })
    ]);
    content.appendChild(el("div", { "class": "panel-row" }, [el("span", { "class": "panel-note", text: "プレビューの内容" }), view]));

    var meta = el("div");
    buildMetaForm(meta);
    var plan = el("div");
    buildPlanForm(plan);

    var s1 = section("号の設定", false, [meta], "sec-meta");
    var s2 = section("セクション・記事・担当", true, [plan], "sec-plan");
    if (!isEditor()) { makeReadOnly(s1); makeReadOnly(s2); }
    var pageSection = section("ページ・セクション・記事の配置", true, [buildPageOrder()], "sec-pages");
    if (!isEditor()) { makeReadOnly(pageSection); }
    content.appendChild(pageSection);
    content.appendChild(s1);
    content.appendChild(s2);

    exit.appendChild(el("button", { type: "button", "class": "exit-btn", text: "台割シートを印刷",
      onclick: function () { document.body.setAttribute("data-view", "plan"); rerenderAll(); window.print(); } }));
  }

  /* 割合の UI は2段（決定 12）。既定は7つのプリセット。いまの値がどれにも一致しない
     ときは「45%（細かく調整）」のような選択肢を足す（なぜその高さかが見えるように）。
     「細かく調整」は権限ではなく複雑さの出し分け */
  function buildShareControl(a) {
    var wrap = el("div", { "class": "share-control" });
    var current = a.share;
    var isPreset = SHARE_PRESETS.some(function (p) { return p.value === current; });
    var options = SHARE_PRESETS.map(function (p) {
      return el("option", { value: String(p.value), selected: current === p.value ? "selected" : null, text: p.label });
    });
    if (!isPreset) {
      options.push(el("option", { value: String(current), selected: "selected", text: current + "%（細かく調整）" }));
    }
    wrap.appendChild(el("label", { text: "割合" }, [el("select", {
      onchange: function () {
        a.share = this.value === "rest" ? "rest" : clampShare(parseInt(this.value, 10));
        applyShareToDOM(a.id, a.share);
        rerenderAll();
      }
    }, options)]));

    var det = el("details", { "class": "share-control__detail" }, [
      el("summary", { text: "細かく調整（編集長）" }),
      el("p", { "class": "panel-note", text: "5% 刻みで動かせます。紙面の記事の境目をドラッグしても変えられます。" })
    ]);
    if (current === "rest") {
      det.appendChild(el("p", { "class": "panel-note",
        text: "「残り」の間は数値を持ちません。プリセットで％を選ぶと、ここで細かく調整できます。" }));
    } else {
      var out = el("span", { "class": "share-control__value t-num", text: current + "%" });
      det.appendChild(el("div", { "class": "share-control__range" }, [el("input", {
        type: "range", min: "0", max: "100", step: "5", value: String(current),
        oninput: function () {
          a.share = clampShare(parseInt(this.value, 10));
          out.textContent = a.share + "%";
          applyShareToDOM(a.id, a.share);
          renderShareHandles();
        },
        onchange: function () { rerenderAll(); }
      }), out]));
    }
    wrap.appendChild(det);
    return wrap;
  }

  function ownerSelect(a) {
    var people = members().filter(function (m) { return m.role !== "viewer"; });
    /* 名簿が無い号（初期設定前・過去号）では自由入力に落とす */
    if (!people.length) {
      var label = field("担当者", a.owner, function (v) { a.owner = v; rerenderAll(); });
      $("input", label).setAttribute("data-owner-for", a.id);
      return label;
    }
    var opts = [el("option", { value: "", text: "（未定）", selected: !a.owner ? "selected" : null })].concat(
      people.map(function (m) {
        return el("option", { value: m.name, text: m.name, selected: a.owner === m.name ? "selected" : null });
      }));
    /* 名簿に無い名前が入っている号でも、黙って消さずに選択肢として見せる */
    if (a.owner && !memberByName(a.owner)) {
      opts.push(el("option", { value: a.owner, text: a.owner + "（名簿に無い）", selected: "selected" }));
    }
    return el("label", { text: "担当者" }, [el("select", {
      "data-owner-for": a.id,
      onchange: function () {
        a.owner = this.value;
        var m = memberByName(a.owner);
        if (m && m.contact) { a.contact = m.contact; }
        rerenderAll();
      }
    }, opts)]);
  }

  function buildPlanForm(container) {
    var placement = articlePlacement();
    var planned = plannedTotal(), actual = pages().length;

    container.appendChild(el("div", { "class": "page-ops" }, [
      el("span", { "class": "page-ops__count", "data-mismatch": planned !== actual ? "true" : "false",
        text: "予定 " + planned + " ページ／紙面 " + actual + " ページ" }),
      el("button", { type: "button", "class": "panel-btn", text: "不足しているページを作る", onclick: syncPagesToPlan }),
      el("button", { type: "button", "class": "panel-btn", text: "＋ 頁",
        title: "末尾に白紙のページを 1 枚足す。記事はページ一覧から配置できます",
        disabled: actual >= MAX_PAGES ? "disabled" : null, onclick: addPage })
    ]));
    container.appendChild(el("p", { "class": "panel-note",
      text: "ページ → セクション → 記事の順で組みます。セクションは共通見出しと並べ方、記事は写真・本文の型を選びます。" }));

    effectiveSections().forEach(function (frame) {
      var fcard = el("div", { "class": "frame-card", "data-focus": focusAttrOfSection(frame) });
      fcard.appendChild(el("div", { "class": "frame-card__head" }, [
        el("input", { type: "text", value: frame.title, "aria-label": "セクション名",
              oninput: function () { frame.title = this.value; syncSectionTitle(frame); syncMeta(); renderPlanSheetIfShown(); } }),

        (!(frame.articles || []).length)
          ? el("button", { type: "button", "class": "frame-card__del", text: "セクションを外す", onclick: function () { deleteSection(frame); } })
          : null
      ]));

      fcard.appendChild(el("label", { text: "セクションテンプレート" }, [el("select", {
        "data-section-template-for": frame.id,
        onchange: function () { frame.template = this.value; applySectionTemplate(frame); rerenderAll(); }
      }, sectionTemplates().map(function (t) {
        return el("option", { value: t.id, selected: frame.template === t.id ? "selected" : null, text: t.label });
      }))]));

      fcard.appendChild(el("label", { text: "占有ページ数" }, [el("input", {
        type: "number", min: "0", max: String(MAX_PAGES), value: String(sectionPlannedPages(frame)),
        onchange: function () { setSectionPages(frame, parseInt(this.value, 10)); rerenderAll(); }
      })]));

      (frame.articles || []).forEach(function (articleId) {
        var a = articleById(articleId);
        if (!a) { return; }
        if (a.continues) {
          var childCard = el("div", { "class": "article-card article-card--nested article-card--continuation",
            "data-focus": focusAttrOf(a.id) });
          childCard.appendChild(el("div", { "class": "article-card__head" }, [
            el("span", { "class": "article-card__place", text: "↳ 続き（" + displayTitleOf(a).replace(/^続き（|）$/g, "") + "）" })
          ]));
          childCard.appendChild(el("p", { "class": "panel-note", text: "記事テンプレートは親記事の「" + articleTemplate(a).label + "」を使います。" }));
          if ((frame.articles || []).length > 1) { childCard.appendChild(buildShareControl(a)); }
          fcard.appendChild(childCard);
          return;
        }

        var card = el("div", { "class": "article-card article-card--nested", "data-focus": focusAttrOf(a.id) });
        card.appendChild(el("div", { "class": "article-card__head" }, [
          el("span", { "class": "article-card__place", text: placementLabelForArticle(a.id, placement) }),
          el("button", { type: "button", "class": "article-card__del", text: "外す", title: "この記事を計画から外す",
            onclick: function () { deleteArticle(a); } })
        ]));
        card.appendChild(el("label", { text: "記事テンプレート" }, [el("select", {
          "data-template-for": a.id, "aria-label": "「" + a.title + "」の記事テンプレート",
          onchange: function () { setArticleTemplate(a, this.value); }
        }, articleTemplates().map(function (t) {
          return el("option", { value: t.id, selected: a.template === t.id ? "selected" : null, text: t.label });
        }))]));
        card.appendChild(el("p", { "class": "panel-note", text: articlePages(a.id).length
          ? "配置済みの原稿は保持します。型の変更は、新しく配置する入れ物に反映されます。"
          : "上のページ一覧でこの記事を選び、「記事を配置」を押してください。" }));
        card.appendChild(field("記事名", a.title, function (v) { a.title = v; syncMeta(); renderPlanSheetIfShown(); renderToc(); }));
        if ((frame.articles || []).length > 1) { card.appendChild(buildShareControl(a)); }
        card.appendChild(ownerSelect(a));
        card.appendChild(field("連絡先", a.contact, function (v) { a.contact = v; syncMeta(); }));

        var det = el("details", { "class": "article-card__dates" }, [el("summary", { text: "この記事だけの締切を設定する" })]);
        ["manuscript", "proof1", "proof2"].forEach(function (id) {
          var s = STAGES.find(function (x) { return x.id === id; });
          det.appendChild(field(s.label, (a.schedule && a.schedule[id]) || "", function (v) {
            if (v) { a.schedule[id] = v; } else { delete a.schedule[id]; }
            rerenderAll();
          }, "date"));
        });
        det.appendChild(el("p", { "class": "panel-note", text: "空欄なら「号の設定」の既定が使われます。" }));
        card.appendChild(det);

        var child = continuationOf(a.id);
        var row = el("div");
        if (child) {
          card.appendChild(el("p", { "class": "panel-note",
            text: "この記事は " + placementLabelForArticle(a.id, placement) + " に分かれています（続き: " + child.id + "）。" }));
        } else if ((frame.articles || []).length > 1 || sectionPlannedPages(frame) > 1) {
          row.appendChild(el("button", { type: "button", "class": "article-card__sub", text: "＋ 続きを作る",
            title: "次のページへ続く入れ物を計画に足す。紙面には「不足しているページを作る」で置く",
            onclick: function () { addContinuation(a); rerenderAll(); } }));
        }
        card.appendChild(row);
        fcard.appendChild(card);
      });

      fcard.appendChild(el("button", { type: "button", "class": "article-card__sub", text: "＋ このセクションに記事を足す",
        title: "同じページを分け合う記事を足す（割合で場所を分ける）",
        onclick: function () { addArticleToSection(frame); rerenderAll(); } }));
      container.appendChild(fcard);
    });

    container.appendChild(el("button", { type: "button", "class": "panel-btn", text: "＋ セクションを作る",
      onclick: function () { addSection(); rerenderAll(); } }));
  }

  function focusAttrOfSection(frame) {
    if (focusOwner() === null) { return null; }
    return (frame.articles || []).some(function (id) { return focusAttrOf(id) === "mine"; }) ? "mine" : "other";
  }

  /* 判型・締切。号にひとつの値（決定 1-a・決定 2） */
  function buildMetaForm(container) {
    container.appendChild(el("h2", { text: "号の情報" }));
    container.appendChild(field("号数・タイトル", state.meta.issue, function (v) { state.meta.issue = v; syncMeta(); }));
    container.appendChild(field("発行日", state.meta.date, function (v) { state.meta.date = v; syncMeta(); }, "date"));

    container.appendChild(el("h2", { text: "編集責任者" }));
    container.appendChild(field("氏名", state.meta.editor.name, function (v) { state.meta.editor.name = v; syncMeta(); }));
    container.appendChild(field("連絡先", state.meta.editor.contact, function (v) { state.meta.editor.contact = v; syncMeta(); }));

    container.appendChild(el("h2", { text: "判型" }));
    container.appendChild(el("label", { text: "判型（現在は A4 のみ）" }, [el("select", {
      onchange: function () {
        state.meta.format = this.value;
        document.documentElement.setAttribute("data-format", this.value);
        rerenderAll();
      }
    }, FORMATS.map(function (f) {
      return el("option", { value: f.id, disabled: f.enabled ? null : "disabled",
        selected: state.meta.format === f.id ? "selected" : null, text: f.label + (f.enabled ? "" : "（未対応）") });
    }))]));

    container.appendChild(el("h2", { text: "記事の締切の既定（原稿・初校・再校）" }));
    container.appendChild(el("p", { "class": "panel-note", text: "記事側で締切を指定しなかった場合に使われます。" }));
    ["manuscript", "proof1", "proof2"].forEach(function (id) {
      var s = STAGES.find(function (x) { return x.id === id; });
      container.appendChild(field(s.label, state.meta.schedule[id], function (v) {
        state.meta.schedule[id] = v; rerenderAll();
      }, "date"));
    });

    container.appendChild(el("h2", { text: "入校日（号）" }));
    container.appendChild(el("p", { "class": "panel-note", text: "印刷所へ入稿データを渡す日。号にひとつだけで、記事ごとの上書きはありません。" }));
    container.appendChild(field("入校日", state.meta.schedule[FINAL_STAGE_ID], function (v) {
      state.meta.schedule[FINAL_STAGE_ID] = v; rerenderAll();
    }, "date"));
  }

  /* ---- 原稿作成 ----------------------------------------------------------- */

  function articleStatusLine(a) {
    var cur = currentOf(a);
    var st = STAGES.find(function (s) { return s.id === cur; });
    var due = dueOf(a, "manuscript");
    if (cur !== "manuscript") { return { text: "原稿提出済み（いま " + (st ? st.label : cur) + "）", level: "ok" }; }
    var late = daysLate(due);
    return late ? { text: "原稿締切 " + mmdd(due) + "（" + late + " 日超過）", level: "error" }
                : { text: "原稿締切 " + mmdd(due), level: "todo" };
  }

  function firstNodeOf(a) { return $('.page [data-article="' + a.id + '"]'); }

  function writeCard(a, placement) {
    var node = articleNode(a.id) || firstNodeOf(a);
    var status = articleStatusLine(a);
    var card = el("div", { "class": "work-card", "data-mine": ownsArticle(a) ? "true" : null, "data-focus": focusAttrOf(a.id) }, [
      el("div", { "class": "work-card__title", text: a.title }),
      el("div", { "class": "work-card__meta", text: placementLabelForArticle(a.id, placement) + "　" + (a.owner || "担当未定") }),
      el("div", { "class": "work-card__status", "data-level": status.level, text: status.text })
    ]);
    if (node && articleOverflowPx(articleNode(a.id)) > 2) {
      card.appendChild(el("div", { "class": "work-card__status", "data-level": "error",
        text: "割当を約 " + Math.round(articleOverflowPx(articleNode(a.id)) / 3.78) + "mm 超えています" }));
    }
    var row = el("div", { "class": "work-card__actions" });
    if (node) {
      row.appendChild(el("button", { type: "button", "class": "is-primary", text: canWrite(a) ? "原稿を書く" : "紙面を見る",
        onclick: function () { revealPaperNode(node, canWrite(a)); } }));
    }
    if (canWrite(a)) {
      var child = continuationOf(a.id);
      if (child) { buildContinuationButtons(a, child).forEach(function (b) { row.appendChild(b); }); }
      if (currentOf(a) === "manuscript") {
        row.appendChild(el("button", { type: "button", "class": "is-primary", text: "原稿を提出する",
          onclick: function () { advanceStage(a, "proof1"); } }));
      }
    }
    card.appendChild(row);
    return card;
  }

  function buildWriteStep(content, exit) {
    var placement = articlePlacement();
    var prim = primaryArticles();
    var mine = prim.filter(ownsArticle);
    var targets = isEditor() ? prim : mine;
    var items = [];

    targets.forEach(function (a) {
      if (currentOf(a) !== "manuscript") { return; }
      var late = daysLate(dueOf(a, "manuscript"));
      items.push({
        level: late ? "error" : "todo", node: firstNodeOf(a),
        text: (isEditor() && !ownsArticle(a) ? (a.owner || "担当未定") + "：" : "") + "「" + a.title + "」の原稿" +
              (late ? "（" + late + " 日超過）" : "（締切 " + mmdd(dueOf(a, "manuscript")) + "）")
      });
    });
    targets.forEach(function (a) {
      var node = articleNode(a.id);
      if (node && articleOverflowPx(node) > 2) {
        items.push({ level: "error", node: node,
          text: "「" + a.title + "」が割当を約 " + Math.round(articleOverflowPx(node) / 3.78) + "mm 超えています（削るか、続きへ送る）" });
      }
    });
    items.sort(function (x, y) { return (y.level === "error") - (x.level === "error"); });

    if (role() === "viewer") {
      content.appendChild(lockNote("閲覧のみです。原稿は担当者だけが書けます。"));
    } else {
      content.appendChild(nextBox(items));
      content.appendChild(el("p", { "class": "panel-note", text: isEditor()
        ? "編集長はすべての記事を書けます。「表示」で担当者を選ぶと、その人の記事以外が灰色になり、書けなくなります。"
        : "書けるのは自分の担当記事だけです（紙面で青く囲まれた部分）。ほかの担当のページは灰色になります。" }));
    }
    if (isEditor()) { content.appendChild(buildFocusSelect()); }

    if (role() === "staff") {
      content.appendChild(section("自分の担当（" + mine.length + "）", true,
        mine.length ? mine.map(function (a) { return writeCard(a, placement); })
                    : [el("p", { "class": "panel-note", text: "担当の記事はありません。" })], "sec-mine"));
      content.appendChild(section("ほかの記事（読むだけ）", false,
        prim.filter(function (a) { return !ownsArticle(a); }).map(function (a) { return writeCard(a, placement); }), "sec-others"));
    } else {
      content.appendChild(section("記事（" + prim.length + "）", true,
        prim.map(function (a) { return writeCard(a, placement); }), "sec-all"));
    }

    var pending = targets.filter(function (a) { return currentOf(a) === "manuscript"; }).length;
    if (role() !== "viewer") {
      exit.appendChild(el("p", { "class": "exit-note",
        text: pending ? "未提出 " + pending + " 本。提出すると校正へ進みます。保存は Ctrl+S。" : "原稿はすべて提出済みです。" }));
    }
  }

  /* ---- 校正 --------------------------------------------------------------- */

  function buildStageRow(a) {
    var tr = el("tr", { "data-focus": focusAttrOf(a.id) });
    tr.appendChild(el("td", { "class": "stage-grid__title", "data-owner-missing": a.owner ? null : "true", text: a.title }));
    tr.appendChild(el("td", { "class": "stage-grid__owner" }, [
      el("span", { "data-missing": a.owner ? null : "true", text: a.owner || "未設定" })
    ]));
    STAGES.forEach(function (s) {
      var st = stageState(a, s.id);
      tr.appendChild(el("td", {
        "class": "stage-grid__cell", "data-state": st,
        title: s.label + "：" + stateLabel(st) + (canAdvance(a) ? "（押すとこの工程まで進める）" : ""),
        "data-locked": canAdvance(a) ? null : "true",
        onclick: function () { if (canAdvance(a)) { advanceStage(a, s.id); } }
      }, [
        el("span", { "class": "stage-grid__dot" }),
        el("span", { "class": "stage-grid__due t-num", text: s.id === "signoff" ? "" : mmdd(dueOf(a, s.id)) })
      ]));
    });
    return tr;
  }

  function buildStageGridTable() {
    var table = el("table", { "class": "stage-grid" });
    table.appendChild(el("thead", null, [el("tr", null, [el("th", { text: "記事" }), el("th", { text: "担当者" })].concat(
      STAGES.map(function (s) { return el("th", { "class": "t-num", text: s.short }); })))]));
    var tbody = el("tbody");
    effectiveSections().forEach(function (frame) {
      var list = (frame.articles || []).map(articleById).filter(function (a) { return a && !a.continues; });
      if (!list.length) { return; }
      tbody.appendChild(el("tr", { "class": "stage-grid__frame-row", "data-focus": focusAttrOfSection(frame) }, [
        el("td", { colspan: String(2 + STAGES.length), text: frame.title })
      ]));
      list.forEach(function (a) { tbody.appendChild(buildStageRow(a)); });
    });
    table.appendChild(tbody);
    return table;
  }

  function commentItem(c) {
    var li = el("li", { "class": "comment", "data-resolved": c.resolved ? "true" : null }, [
      el("div", { "class": "comment__head", text: c.author + (c.at ? "　" + c.at.slice(5, 10).replace("-", "/") : "") + (c.resolved ? "（解決済み）" : "") }),
      c.quote ? el("blockquote", { "class": "comment__quote", text: c.quote }) : null,
      el("div", { "class": "comment__body", text: c.text })
    ]);
    if (!c.resolved && canResolve(c)) {
      li.appendChild(el("button", { type: "button", "class": "comment__resolve", text: "解決済みにする",
        onclick: function () { c.resolved = true; markDirty("comments"); rerenderAll(); } }));
    }
    return li;
  }

  function commentForm(a) {
    var quote = state.quote && state.quote.article === a.id ? state.quote.text : "";
    var ta = el("textarea", { rows: "2", placeholder: "例：日付の表記を「9月15日」にそろえる" });
    return el("div", { "class": "comment-form" }, [
      quote ? el("blockquote", { "class": "comment__quote", text: quote }) : null,
      ta,
      el("button", { type: "button", text: "コメントする", onclick: function () {
        var text = ta.value.trim();
        if (!text) { ta.focus(); return; }
        state.comments.push({
          id: "c" + Date.now().toString(36), article: a.id, author: state.viewer.name,
          text: text, quote: quote, resolved: false, at: new Date().toISOString().slice(0, 16)
        });
        if (quote) { state.quote = null; }
        ta.value = "";
        markDirty("comments");
        rerenderAll();
      } })
    ]);
  }

  function buildProofStep(content, exit) {
    var prim = primaryArticles();
    var items = [];
    prim.forEach(function (a) {
      var open = openCommentCount(a.id);
      if (open && (isEditor() || ownsArticle(a))) {
        items.push({ level: "warn", node: firstNodeOf(a), text: "「" + a.title + "」に未解決のコメント " + open + " 件" });
      }
      var cur = currentOf(a);
      if ((cur === "proof1" || cur === "proof2") && (isEditor() || ownsArticle(a))) {
        var late = daysLate(dueOf(a, cur));
        var st = STAGES.find(function (s) { return s.id === cur; });
        if (late) { items.push({ level: "error", text: "「" + a.title + "」の" + st.label + "が " + late + " 日超過" }); }
      }
    });

    if (role() === "viewer") {
      content.appendChild(lockNote("閲覧のみです。コメントは編集長と担当者が付けられます。"));
    } else {
      content.appendChild(nextBox(items));
      content.appendChild(el("p", { "class": "panel-note", text: "どの記事にもコメントできます。直接書き直せるのは" +
        (isEditor() ? "すべての記事です。" : "自分の担当記事だけです。") + "紙面の文字を選ぶと、その箇所を引用してコメントできます。" }));
    }

    var sc = signoffCount();
    var grid = el("div", { "class": "stage-grid-wrap" }, [
      buildStageGridTable(),
      el("p", { "class": "panel-note", text: "入校日（号）: " + (state.meta.schedule[FINAL_STAGE_ID] || "未設定") }),
      (sc.total && sc.done === sc.total) ? el("p", { "class": "stage-grid__ready", text: "全記事が校了しました。入稿できます" }) : null,
      el("p", { "class": "panel-note", text: isEditor() ? "マスを押すとその工程まで進みます。" : "進められるのは自分の担当記事の行だけです。" })
    ]);
    content.appendChild(section("工程", true, [grid], "sec-stages"));

    var list = el("div");
    if (state.quote) {
      var qa = articleById(state.quote.article);
      list.appendChild(el("p", { "class": "quote-pick", text: "選択中：「" + state.quote.text + "」（" + (qa ? qa.title : "") + "）" }));
    }
    prim.forEach(function (a) {
      var cs = commentsOf(a.id);
      var openN = cs.filter(function (c) { return !c.resolved; }).length;
      var block = section(a.title + (openN ? "　未解決 " + openN : ""),
        !!(state.quote && state.quote.article === a.id) || (openN > 0 && ownsArticle(a)),
        [el("ul", { "class": "comment-list" }, cs.map(commentItem)), canComment() ? commentForm(a) : null], "sec-c-" + a.id);
      block.classList.add("panel-section--sub");
      if (state.quote && state.quote.article === a.id) { block.setAttribute("data-force-open", "true"); }
      list.appendChild(block);
    });
    content.appendChild(section("コメント", true, [list], "sec-comments"));

    exit.appendChild(el("button", { type: "button", "class": "exit-btn", text: "校正紙を印刷",
      onclick: function () { window.print(); } }));
  }

  /* ---- 入稿 --------------------------------------------------------------- */

  function buildReleaseStep(content, exit) {
    var errors = findings.filter(function (f) { return f.level === "error"; }).length;
    var sc = signoffCount();
    var remaining = VISUAL_CHECKLIST.filter(function (_, i) { return !state.checklist["v" + i]; }).length;

    if (!isEditor()) {
      content.appendChild(lockNote("入稿は編集長の作業です。入稿データを見ること・印刷することはできます。"));
    } else {
      var items = [];
      if (sc.done < sc.total) { items.push({ level: "error", text: "校了していない記事が " + (sc.total - sc.done) + " 本あります" }); }
      if (errors) { items.push({ level: "error", text: "検査の［入稿を止める］指摘が " + errors + " 件あります" }); }
      if (remaining) { items.push({ text: "目視チェックが " + remaining + " 項目残っています" }); }
      if (anyDirty()) { items.push({ level: "warn", text: "未保存の変更があります（Ctrl+S）" }); }
      content.appendChild(nextBox(items));
    }
    content.appendChild(el("p", { "class": "panel-note", text: "入稿では校正情報（各ページ下端の担当・進行）とガイドを自動で外しています。" }));

    var visual = el("div");
    VISUAL_CHECKLIST.forEach(function (label, i) {
      visual.appendChild(el("label", { "class": "panel-check" }, [
        el("input", { type: "checkbox", checked: state.checklist["v" + i] ? "checked" : null,
          onchange: function () { state.checklist["v" + i] = this.checked; renderPanel(); } }),
        el("span", { text: " " + label })
      ]));
    });
    var s = section("入稿前チェック（人が見るもの）", true, [visual], "sec-visual");
    if (!isEditor()) { makeReadOnly(s); }
    content.appendChild(s);

    var ready = sc.done === sc.total && !errors && !remaining;
    exit.appendChild(el("button", { type: "button", "class": "exit-btn exit-btn--secondary", text: "入稿データを印刷",
      onclick: function () { window.print(); } }));
    if (isEditor()) {
      exit.appendChild(el("button", {
        type: "button", "class": "exit-btn", "data-ready": ready ? "true" : "false",
        text: state.meta.released ? "発行済み（取り消す）" : "発行済みにする",
        title: ready ? "" : "未完了の項目がありますが、押すことはできます",
        onclick: function () { state.meta.released = !state.meta.released; rerenderAll(); }
      }));
    }
  }

  /* ==========================================================================
     台割シート（編集計画から毎回作り直す帳票。紙面ではない）
     ========================================================================== */

  function renderPlanSheetIfShown() {
    if (document.body.getAttribute("data-view") === "plan") { renderPlanSheet(); }
  }

  function renderPlanSheet() {
    var old = $(".plan-sheet");
    if (old) { old.remove(); }
    var placement = articlePlacement();
    var n = Math.max(plannedTotal(), pages().length);

    var cells = [];
    for (var i = 1; i <= n; i++) {
      var here = [];
      Object.keys(placement).forEach(function (id) {
        if (placement[id].pages.indexOf(i) >= 0) {
          var a = articleById(id);
          var t = a ? (a.continues ? displayTitleOf(a) : a.title) : id;
          if (here.indexOf(t) < 0) { here.push(t); }
        }
      });
      cells.push(el("div", { "class": "plan-map__cell", "data-empty": here.length ? "false" : "true",
        "data-beyond": i > pages().length ? "true" : "false" }, [
        el("span", { "class": "plan-map__no", text: String(i) }),
        el("span", { "class": "plan-map__title", text: here.join(" / ") || "未割当" })
      ]));
    }

    var rows = primaryArticles().map(function (a) {
      var frame = sectionOfArticle(a.id);
      return el("tr", null, [
        el("td", { text: frame ? frame.title : "—" }),
        el("td", { text: a.title }),
        el("td", { text: placementLabelForArticle(a.id, placement) }),
        el("td", { text: a.owner || "未設定", "data-warn": a.owner ? null : "true" }),
        el("td", { "class": "t-num", text: a.contact || "" })
      ].concat(STAGES.map(function (s) {
        return el("td", { "class": "t-num", "data-state": stageState(a, s.id),
          text: s.id === "signoff" ? (signoffDone(a) ? "済" : "") : mmdd(dueOf(a, s.id)) });
      })));
    });

    var sc = signoffCount();
    document.body.appendChild(el("section", { "class": "plan-sheet" }, [
      el("header", { "class": "plan-sheet__head" }, [
        el("h1", { text: "編集計画（台割）" }),
        el("p", { text: [state.meta.issue, state.meta.date ? "発行 " + state.meta.date : "",
          "全 " + (plannedTotal() || pages().length) + " ページ",
          "入校日 " + (state.meta.schedule[FINAL_STAGE_ID] || "未設定"),
          "校了 " + sc.done + "/" + sc.total,
          "編集責任者 " + (state.meta.editor.name || "未設定")].filter(Boolean).join("　／　") })
      ]),
      el("h2", { text: "台割" }),
      el("div", { "class": "plan-map" }, cells),
      el("h2", { text: "記事・担当・工程" }),
      el("table", { "class": "plan-table" }, [
        el("thead", null, [el("tr", null, [
          el("th", { scope: "col", text: "セクション" }), el("th", { scope: "col", text: "記事" }),
          el("th", { scope: "col", text: "掲載" }), el("th", { scope: "col", text: "担当者" }),
          el("th", { scope: "col", text: "連絡先" })
        ].concat(STAGES.map(function (s) { return el("th", { scope: "col", text: s.label }); })))]),
        el("tbody", null, rows)
      ]),
      el("p", { "class": "plan-sheet__note", text: "網掛けは完了した工程、枠付きは現在の工程、赤字は期日超過を表します。入校日は号にひとつです。" })
    ]));
  }

  /* ==========================================================================
     設定（会報ごと。テンプレートの定型と名簿）
     --------------------------------------------------------------------------
     保存先は号の HTML ではなく brands/<組織>/settings.js。
     system/ に団体固有の定型文や人の名前を混ぜるとホワイトラベルが崩れる。
     変更できるのは編集長だけ（名簿が無いあいだは開いた人が編集長）。
     ========================================================================== */

  function openSettings(tab) {
    if (tab) { state.settingsTab = tab; }
    document.body.setAttribute("data-settings", "open");
    renderSettings();
  }
  function closeSettings() {
    document.body.removeAttribute("data-settings");
    var v = $(".settings-view");
    if (v) { v.remove(); }
    rerenderAll();
  }

  function settingsEntry(id, kind) {
    var t = kind === "section" ? state.settings.sectionTemplates : state.settings.articleTemplates;
    if (!t[id]) { t[id] = {}; }
    return t[id];
  }

  function settingsChanged() { markDirty("settings"); }

  /* 見本の markup。記事 ID の場所は目印のまま組み、画像の場所は号の階層に合わせる */
  function previewMarkup(t, kind) {
    if (kind === "section") {
      var node = sectionHolder({ id: SECTION_TOKEN, title: t.label, template: t.id }, 0);
      var slot = $("[data-section-articles]", node);
      for (var i = 0; i < (state.tplArticleCount || 1); i++) {
        var sample = articleHolder({ id: "preview-" + i, template: "free", share: "rest" }, 0, true);
        sample.setAttribute("data-preview-article", "true");
        slot.appendChild(sample);
      }
      return node.outerHTML;
    }
    var html = typeof t.markup === "function" ? t.markup(ARTICLE_TOKEN, 0) : articleMarkup(ARTICLE_TOKEN, true);
    return rebaseMarkup(html);
  }

  /* 定型部分＝data-editable が付いていない文字。担当者が書く欄＝data-editable。
     設定で直せるのは定型部分だけ。書く欄の中身は号ごとの原稿なので触らない */
  function markFixedParts(root, editable) {
    $$("h1,h2,h3,h4,p,li,dt,dd,th,td,figcaption,span", root).forEach(function (n) {
      if (n.closest("[data-editable]") || n.closest("[data-toc]")) { return; }
      if (!n.textContent.trim()) { return; }
      if ($("h1,h2,h3,h4,p,li,dt,dd,th,td,figcaption", n)) { return; }
      n.setAttribute("data-fixed", "true");
      if (editable) { n.setAttribute("contenteditable", "true"); }
    });
  }

  function buildTemplateEditor(t, kind) {
    var ro = !isEditor();
    var wrap = el("div", { "class": "tpl-edit" });
    function setField(k, v) { t[k] = v; settingsEntry(t.id, kind)[k] = v; settingsChanged(); }

    var form = el("div", { "class": "tpl-edit__form" }, [
      field("名前", t.label, function (v) { setField("label", v); renderTemplateList(); }),
      el("label", { text: "既定のページ数" }, [el("input", { type: "number", min: "1", max: String(MAX_PAGES),
        value: String(t.pages || 1), oninput: function () { setField("pages", parseInt(this.value, 10) || 1); } })]),
      el("label", { text: "置き場所" }, [el("select", { onchange: function () { setField("fixed", this.value || null); } }, [
        el("option", { value: "", text: "どこでも", selected: !t.fixed ? "selected" : null }),
        el("option", { value: "first", text: "号の先頭", selected: t.fixed === "first" ? "selected" : null }),
        el("option", { value: "last", text: "号の末尾", selected: t.fixed === "last" ? "selected" : null })
      ])]),
      el("label", { "class": "panel-check" }, [
        el("input", { type: "checkbox", checked: t.toc ? "checked" : null, onchange: function () { setField("toc", this.checked); } }),
        el("span", { text: " 表紙の目次に載せる" })
      ]),
      el("label", { "class": "panel-check" }, [
        el("input", { type: "checkbox", checked: t.once ? "checked" : null, onchange: function () { setField("once", this.checked); } }),
        el("span", { text: " 1 号に 1 回だけ" })
      ])
    ]);
    if (kind === "section") {
      /* 記事側のページ数・目次・固定位置とは別の、セクションの設定。 */
      while (form.children.length > 1) { form.lastChild.remove(); }
      form.appendChild(el("label", { text: "記事の並べ方" }, [el("select", {
        "aria-label": "記事の並べ方", onchange: function () { setField("layout", this.value); rebuildTemplates(); renderSettings(); }
      }, [el("option", { value: "stack", text: "縦に並べる", selected: t.layout !== "columns" ? "selected" : null }),
          el("option", { value: "columns", text: "横に並べる", selected: t.layout === "columns" ? "selected" : null })])]));
      form.appendChild(el("label", { "class": "panel-check" }, [el("input", { type: "checkbox", checked: t.heading !== false ? "checked" : null,
        onchange: function () { setField("heading", this.checked); rebuildTemplates(); renderSettings(); } }), el("span", { text: " 共通見出しを表示する" })]));
      wrap.appendChild(el("div", { "class": "seg" }, [1, 2].map(function (count) {
        return el("button", { type: "button", text: "記事 " + count + " 本の見本", "aria-pressed": (state.tplArticleCount || 1) === count ? "true" : "false",
          onclick: function () { state.tplArticleCount = count; renderSettings(); } });
      })));
    }
    if (ro) { makeReadOnly(form); }
    wrap.appendChild(form);

    var kindMode = !ro && state.tplMode === "kind";
    var page = el("section", { "class": "page tpl-preview__page", "data-kind-mode": kindMode ? "true" : null });
    page.innerHTML = '<div class="page__body">' + previewMarkup(t, kind) + "</div>";
    markFixedParts(page, !ro && !kindMode);

    /* 直した見本を設定に書く。目印（data-fixed 等）は外し、画像の場所は
       page-templates.js と同じ形に戻してから持つ（別の階層の号でも使えるように） */
    function store() {
      var clone = $(".page__body", page).cloneNode(true);
      $$("[data-fixed]", clone).forEach(function (n) { n.removeAttribute("data-fixed"); n.removeAttribute("contenteditable"); });
      var entry = settingsEntry(t.id, kind);
      if (!Array.isArray(entry.markup)) { entry.markup = []; }
      if (kind === "section") {
        $$("[data-section-articles]", clone).forEach(function (slot) { slot.innerHTML = ""; });
      }
      entry.markup[0] = canonicalMarkup(clone.innerHTML);
      settingsChanged();
      rebuildTemplates();
    }
    page.addEventListener("input", store);
    page.addEventListener("paste", onPaste);

    /* 欄の種類の切り替え。今のテンプレートはほぼ全部が「書く欄」で、定型をほとんど
       持っていない。どこを毎号同じにするかを決めるのが、この設定の本題 */
    if (kindMode) {
      page.addEventListener("click", function (ev) {
        ev.preventDefault();
        var slot = ev.target.closest("[data-editable]");
        var fixed = ev.target.closest("[data-fixed]");
        if (slot && page.contains(slot)) { slot.removeAttribute("data-editable"); }
        else if (fixed && page.contains(fixed)) { fixed.setAttribute("data-editable", ""); }
        else { return; }
        store();
        renderSettings();
      });
    }

    var modeSeg = ro ? null : el("div", { "class": "seg" }, [
      el("button", { type: "button", text: "定型の文字を直す", "aria-pressed": kindMode ? "false" : "true",
        onclick: function () { state.tplMode = "text"; renderSettings(); } }),
      el("button", { type: "button", text: "定型／書く欄を切り替える", "aria-pressed": kindMode ? "true" : "false",
        onclick: function () { state.tplMode = "kind"; renderSettings(); } })
    ]);
    var edited = settingsMap(kind)[t.id] && settingsMap(kind)[t.id].markup;
    wrap.appendChild(el("div", { "class": "tpl-preview" }, [
      el("div", { "class": "panel-row" }, [el("div", { "class": "tpl-legend" }, [
        el("span", { "class": "tpl-legend__fixed", text: "定型（ここで直す）" }),
        el("span", { "class": "tpl-legend__slot", text: "記事ごとに担当者が書く欄" })
      ]), modeSeg]),
      el("p", { "class": "panel-note", text: kindMode
        ? "部分を押すと「定型」と「書く欄」が入れ替わります。定型にした部分は、号では担当者が書き換えられません。"
        : "黄色い部分（定型）を直接書き換えられます。点線の部分は号ごとに担当者が書く欄です。" +
          ((t.pages || 1) > 1 ? "直せるのは 1 ページ目の見本だけです。" : "") }),
      (!ro && edited) ? el("button", { type: "button", "class": "article-card__sub", text: "見本を元に戻す",
        onclick: function () {
          if (!confirm("このテンプレートの見本を、system/page-templates.js の元の形に戻します。")) { return; }
          delete settingsMap(kind)[t.id].markup;
          settingsChanged(); rebuildTemplates(); renderSettings();
        } }) : null,
      el("div", { "class": "tpl-preview__stage" }, [page])
    ]));
    return wrap;
  }

  function renderTemplateList(list) {
    var kind = templateKind();
    list = list || $("#tpl-list");
    if (!list) { return; }
    list.innerHTML = "";
    templatesOf(kind).forEach(function (t) {
      list.appendChild(el("button", {
        type: "button", "class": "tpl-item", "aria-current": state.templateId === t.id ? "true" : "false",
        onclick: function () { state.templateId = t.id; renderSettings(); }
      }, [
        el("span", { "class": "tpl-item__name", text: t.label }),
        el("span", { "class": "tpl-item__meta",
          text: kind === "section" ? (t.layout === "columns" ? "横並び" : "縦並び") : (t.pages || 1) + "頁" + (t.fixed === "first" ? "・先頭" : t.fixed === "last" ? "・末尾" : "") + (t.toc ? "・目次" : "") })
      ]));
    });
  }

  function buildTemplatesPane(body) {
    var kind = templateKind(), list = templatesOf(kind);
    if (!state.templateId || !findTemplateRaw(state.templateId, kind)) { state.templateId = list[0].id; }
    var t = findTemplateRaw(state.templateId, kind);
    var used = kind === "section" ? sections().filter(function (section) { return section.template === t.id; }).length
      : primaryArticles().filter(function (a) { return articleTemplate(a).id === t.id; }).length;

    var side = el("div", { "class": "tpl-side" }, [
      el("div", { id: "tpl-list", "class": "tpl-list" }),
      isEditor() ? el("button", { type: "button", "class": "panel-btn", text: "＋ 新しいテンプレート",
        onclick: function () {
          var id = newId("custom-", function (x) { return !!findTemplateRaw(x, kind); });
          settingsEntry(id, kind).label = kind === "section" ? "新しいセクションテンプレート" : "新しい記事テンプレート";
          settingsChanged();
          rebuildTemplates();
          state.templateId = id;
          renderSettings();
        } }) : null
    ]);
    body.appendChild(side);
    body.appendChild(el("div", { "class": "settings-main" }, [
      el("h2", { text: t.label }),
      el("p", { "class": "panel-note", text: "この号では " + used + (kind === "section" ? " セクション" : " 本の記事") + "でこのテンプレートを使っています。" +
        "直した内容は、次に作る紙面から反映されます（書き終えた原稿は書き換えません）。" }),
      buildTemplateEditor(t, kind)
    ]));
    renderTemplateList($(".tpl-list", side));
  }

  /* 合言葉は名前と組にして SHA-256 で持つ。平文は設定ファイルに書かない。
     ただしこれは「隣の人の名前で入らない」程度の歯止めで、本人確認ではない */
  function hashPass(name, pass) {
    if (!(window.crypto && crypto.subtle && window.TextEncoder)) {
      return Promise.reject(new Error("このブラウザでは合言葉を扱えません（Chrome で開いてください）"));
    }
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(name + "\n" + pass)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
    });
  }

  function editorCount() { return members().filter(function (m) { return m.role === "editor"; }).length; }

  function buildMembersPane(body) {
    var main = el("div", { "class": "settings-main settings-main--wide" }, [
      el("h2", { text: "名簿" }),
      el("p", { "class": "panel-note", text: "役割は会報ごとに持ちます。編集長は計画・入稿と設定、担当者は割り当てられた記事の原稿と全記事の校正コメント、閲覧者は読むだけです。" }),
      el("p", { "class": "panel-note", text: "合言葉を設定した人は、ログインのときに入力が要ります。合言葉は本人確認の仕組みではありません（号の HTML は誰でも書き換えられます）。" })
    ]);
    var tbody = el("tbody", { role: "rowgroup" });
    /* 同じ入力欄を表とカードで使い、画面幅を変えても編集中の値を失わない。 */
    function memberCell(label, kind, children) {
      return el("td", { role: "cell", "class": "member-field member-field--" + kind }, [
        el("span", { "class": "member-field__label", text: label })
      ].concat(children));
    }
    members().forEach(function (m, idx) {
      var count = primaryArticles().filter(function (a) { return a.owner === m.name; }).length;
      var passCell = el("div", { "class": "member-pass" }, [
        el("span", { "class": "member-pass__state", "data-set": m.pass ? "true" : "false", text: m.pass ? "設定済み" : "なし" }),
        el("button", { type: "button", text: m.pass ? "変える" : "設定する", "aria-label": m.name + "の合言葉を" + (m.pass ? "変更" : "設定"), onclick: function () {
          var p = prompt(m.name + " の合言葉（空欄で外す）", "");
          if (p === null) { return; }
          if (!p) { m.pass = ""; settingsChanged(); renderSettings(); return; }
          hashPass(m.name, p).then(function (h) { m.pass = h; settingsChanged(); renderSettings(); })
            .catch(function (e) { alert(e.message); });
        } })
      ]);
      tbody.appendChild(el("tr", { role: "row", "class": "member-card" }, [
        memberCell("氏名", "name", [el("input", { type: "text", value: m.name, "aria-label": "氏名", onchange: function () {
          var v = this.value.trim();
          if (!v || (v !== m.name && memberByName(v))) { this.value = m.name; showBarToast("同じ名前の人がいるか、空欄です"); return; }
          var old = m.name;
          /* この号の担当者名も追随させる。追随させないと、名前を直した瞬間に
             本人が開いても自分の記事として認識されなくなる。合言葉は名前と組なので外す */
          primaryArticles().forEach(function (a) { if (a.owner === old) { a.owner = v; } });
          if (m.pass) { m.pass = ""; showBarToast("名前を変えたので合言葉を外しました。設定し直してください"); }
          if (state.viewer === m) { sessionStorage.setItem(loginKey(), v); }
          m.name = v;
          settingsChanged(); syncMeta(); renderSettings();
        } })]),
        memberCell("役割", "role", [el("select", { "aria-label": "役割", onchange: function () {
          if (m.role === "editor" && this.value !== "editor" && editorCount() <= 1) {
            this.value = "editor"; showBarToast("編集長が 1 人もいなくなるので変えられません"); return;
          }
          m.role = this.value; settingsChanged(); renderUserChip(); renderSettings();
        } }, ["editor", "staff", "viewer"].map(function (r) {
          return el("option", { value: r, text: ROLE_LABELS[r], selected: m.role === r ? "selected" : null });
        }))]),
        memberCell("連絡先", "contact", [el("input", { type: "text", value: m.contact, "aria-label": "連絡先",
          onchange: function () { m.contact = this.value; settingsChanged(); } })]),
        memberCell("合言葉", "pass", [passCell]),
        memberCell("この号の担当", "count", [el("span", { "class": "member-count t-num", text: count ? count + " 本" : "担当なし" })]),
        memberCell("", "actions", [el("button", { type: "button", "class": "member-del", text: "名簿から外す", "aria-label": m.name + "を名簿から外す", onclick: function () {
          if (m.role === "editor" && editorCount() <= 1) { showBarToast("編集長が 1 人もいなくなるので外せません"); return; }
          if (m === state.viewer) { showBarToast("ログイン中の人は外せません"); return; }
          if (!confirm(m.name + " を名簿から外します。" + (count ? "\nこの号の担当記事（" + count + " 本）は担当者のまま残ります。" : ""))) { return; }
          members().splice(idx, 1); settingsChanged(); renderSettings();
        } })])
      ]));
    });
    main.appendChild(el("table", { role: "table", "aria-label": "会報の名簿", "class": "member-table" }, [
      el("thead", { role: "rowgroup" }, [el("tr", { role: "row" }, ["氏名", "役割", "連絡先", "合言葉", "この号の担当", ""].map(function (h) {
        return el("th", { role: "columnheader", text: h });
      }))]),
      tbody
    ]));
    if (isEditor()) {
      main.appendChild(el("button", { type: "button", "class": "panel-btn", text: "＋ 人を足す", onclick: function () {
        var name = newId("新しい人 ", function (x) { return !!memberByName(x); });
        members().push({ name: name, role: "staff", contact: "", pass: "" });
        settingsChanged(); renderSettings();
      } }));
    } else {
      makeReadOnly(main);
      main.insertBefore(lockNote("設定は編集長だけが変更できます。"), main.children[1]);
    }
    body.appendChild(main);
  }

  function renderSettings() {
    var old = $(".settings-view");
    if (old) { old.remove(); }
    var tabs = [{ id: "sectionTemplates", label: "セクションテンプレート" }, { id: "articleTemplates", label: "記事テンプレート" }, { id: "members", label: "名簿" }];
    var view = el("div", { "class": "settings-view" }, [
      el("div", { "class": "settings-head" }, [
        el("h1", { text: "設定" }),
        el("span", { "class": "panel-note", text: "この会報のひな型と、一緒に作業する人を管理します。" }),
        el("div", { "class": "seg" }, tabs.map(function (t) {
          return el("button", { type: "button", text: t.label, "aria-pressed": state.settingsTab === t.id ? "true" : "false",
            onclick: function () { state.settingsTab = t.id; state.templateId = null; renderSettings(); } });
        })),
        el("span", { "class": "editor-bar__spacer" }),
        el("span", { "class": "editor-bar__status kaiho-savestate", "data-dirty": "false" }),
        el("button", { type: "button", "class": "exit-btn exit-btn--secondary", text: "保存", onclick: save }),
        el("button", { type: "button", "class": "exit-btn", text: "号に戻る", onclick: closeSettings })
      ])
    ]);
    var body = el("div", { "class": "settings-body" });
    if (state.settingsTab === "members") { buildMembersPane(body); } else { buildTemplatesPane(body); }
    if (!isEditor() && state.settingsTab !== "members") {
      body.insertBefore(lockNote("設定は編集長だけが変更できます。"), body.firstChild);
    }
    view.appendChild(body);
    document.body.appendChild(view);
    renderSaveState();
  }

  /* ==========================================================================
     ログイン
     ========================================================================== */

  /* ログイン状態はタブごと（sessionStorage）。号の HTML にも設定にも書かない */
  function loginKey() { return "kaiho-login:" + settingsURL(); }

  function restoreLogin() {
    var name = null;
    try { name = sessionStorage.getItem(loginKey()); } catch (e) { name = null; }
    return name ? memberByName(name) : null;
  }

  function showLogin(onDone) {
    document.body.setAttribute("data-login", "pending");
    var people = members();
    var sel = el("select", { id: "kaiho-login-name" }, people.map(function (m, i) {
      return el("option", { value: String(i), text: m.name + "（" + ROLE_LABELS[m.role] + "）" });
    }));
    var passLabel = el("label", { text: "合言葉" }, [el("input", { type: "password", id: "kaiho-login-pass", autocomplete: "current-password" })]);
    var err = el("p", { "class": "login-card__error", role: "alert" });
    function syncPass() { passLabel.hidden = !people[parseInt(sel.value, 10)].pass; }
    sel.addEventListener("change", syncPass);

    var form = el("form", { "class": "login-card" }, [
      el("span", { "class": "login-card__eyebrow", text: "会報づくりを、ひとつの画面で" }),
      el("h1", { text: "会報スタジオ" }),
      el("p", { "class": "login-card__issue", text: state.meta.issue || "会報の編集" }),
      el("ol", { "class": "login-card__flow", "aria-label": "会報づくりの流れ" }, [
        el("li", { text: "計画" }), el("li", { text: "原稿作成" }), el("li", { text: "校正" }), el("li", { text: "入稿" })
      ]),
      el("p", { "class": "login-card__intro", text: "あなたの名前を選ぶと、担当する記事と次の作業がわかります。" }),
      el("label", { text: "作業する人" }, [sel]),
      passLabel,
      el("button", { type: "submit", text: "はじめる" }),
      err,
      el("p", { "class": "login-card__note", text: "読むだけの方も名前を選べます。名前の追加は編集長が「設定」で行います。この選択は本人確認ではありません。" })
    ]);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var m = people[parseInt(sel.value, 10)];
      var input = $("#kaiho-login-pass").value;
      var check = m.pass ? hashPass(m.name, input).then(function (h) { return h === m.pass; }) : Promise.resolve(true);
      check.then(function (ok) {
        if (!ok) { err.textContent = "合言葉が違います"; return; }
        try { sessionStorage.setItem(loginKey(), m.name); } catch (e) { /* 保存できなくても今回は入れる */ }
        view.remove();
        document.body.removeAttribute("data-login");
        onDone(m);
      }).catch(function (e) { err.textContent = e.message; });
    });
    var view = el("div", { "class": "login-view" }, [form]);
    document.body.appendChild(view);
    syncPass();
    sel.focus();
  }

  function logout() {
    if (anyDirty() && !confirm("保存していない変更があります。ログアウトすると失われます。")) { return; }
    state.dirty = { issue: false, comments: false, settings: false };   /* beforeunload で二重に聞かない */
    try { sessionStorage.removeItem(loginKey()); } catch (e) { /* 無視 */ }
    location.reload();
  }

  /* ==========================================================================
     保存
     --------------------------------------------------------------------------
     書くファイルは最大 3 つ。号の HTML、号の隣の comments.js、会報の settings.js。
     最初の保存で作業フォルダ（リポジトリの根）を 1 度選んでもらい、そこからの
     相対位置に書く。ハンドルは IndexedDB に覚え、次回は許可の確認だけで済む。
     File System Access API が無いブラウザではダウンロードに落とす。
     ========================================================================== */

  function serialize() {
    var clone = document.documentElement.cloneNode(true);

    /* 読み込み時に生成したものはすべて捨てる */
    $$(".editor-bar, .editor-panel, .view-dock, .settings-view, .login-view, .page__guides, .page-tools, " +
       ".production-slug, .plan-sheet, .focus-veil, .share-handle, .continuation-controls, " +
       ".mobile-nav, script[data-kaiho-injected]", clone).forEach(function (n) { n.remove(); });

    ["contenteditable", "data-overflow", "data-overflow-label", "data-side", "data-focus",
     "data-mine", "data-writable", "data-comments"].forEach(function (a) {
      $$("[" + a + "]", clone).forEach(function (n) { n.removeAttribute(a); });
    });

    var metaNode = $("#kaiho-meta", clone);
    if (metaNode) { metaNode.textContent = "\n" + JSON.stringify(state.meta, null, 2) + "\n"; }

    var body = $("body", clone);
    if (body) {
      /* 作業台の状態は号の内容ではない。data-proof も工程から決まるので残さない（決定 14） */
      ["data-mode", "data-guides", "data-view", "data-spread", "data-proof", "data-step", "data-role",
       "data-focus", "data-settings", "data-resizing", "data-login", "data-surface"].forEach(function (a) { body.removeAttribute(a); });
      body.style.removeProperty("--zoom");
      if (!body.getAttribute("style")) { body.removeAttribute("style"); }
    }
    clone.style.removeProperty("--bar-h");
    clone.style.removeProperty("--panel-w");
    if (!clone.getAttribute("style")) { clone.removeAttribute("style"); }

    return "<!doctype html>\n" + clone.outerHTML + "\n";
  }

  function serializeComments() {
    return "/* 校正コメント（会報スタジオが書き出す）。号の HTML には入れない（docs/09 §3.1）。\n" +
           "   手で直すときは JSON として正しい形を保つこと。 */\n" +
           "window.KAIHO_COMMENTS = " + JSON.stringify(state.comments, null, 2) + ";\n";
  }

  function serializeSettings() {
    var s = JSON.parse(JSON.stringify(state.settings));
    ["sectionTemplates", "articleTemplates"].forEach(function (key) {
      Object.keys(s[key]).forEach(function (id) { if (!Object.keys(s[key][id]).length) { delete s[key][id]; } });
    });
    return "/* 会報ごとの設定（会報スタジオの ⚙ 設定が書き出す）。\n" +
           "   members: 名簿。role は editor（編集長）/ staff（担当者）/ viewer（閲覧者）。\n" +
           "            pass は合言葉の SHA-256（名前と組）。平文を書かないこと。\n" +
           "   sectionTemplates / articleTemplates: 種類別の型の上書き。markup[0] は見本。\n" +
           "   手で直すときは JSON として正しい形を保つこと。 */\n" +
           "window.KAIHO_SETTINGS = " + JSON.stringify(s, null, 2) + ";\n";
  }

  /* --- 作業フォルダのハンドル（IndexedDB に覚える） ------------------------- */

  function idb(mode, fn) {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { resolve(null); return; }
      var req = indexedDB.open("kaiho-studio", 1);
      req.onupgradeneeded = function () { req.result.createObjectStore("handles"); };
      req.onerror = function () { resolve(null); };
      req.onsuccess = function () {
        var tx = req.result.transaction("handles", mode);
        var r = fn(tx.objectStore("handles"));
        tx.oncomplete = function () { resolve(r && r.result !== undefined ? r.result : null); };
        tx.onerror = function () { reject(tx.error); };
      };
    });
  }

  function rootHandle() {
    if (!window.showDirectoryPicker) { return Promise.resolve(null); }
    function usable(h) {
      if (!h) { return Promise.resolve(null); }
      var opts = { mode: "readwrite" };
      return h.queryPermission(opts).then(function (p) {
        if (p === "granted") { return h; }
        return h.requestPermission(opts).then(function (p2) { return p2 === "granted" ? h : null; });
      }).catch(function () { return null; });
    }
    return usable(state.root)
      .then(function (h) {
        return h || idb("readonly", function (st) { return st.get("root"); }).catch(function () { return null; }).then(usable);
      })
      .then(function (h) {
        if (h) { return h; }
        alert("保存先の作業フォルダ（kaiho-studio のフォルダ。issues と brands が入っている場所）を選んでください。\n" +
              "次からは選ばずに保存できます。");
        return window.showDirectoryPicker({ id: "kaiho-root", mode: "readwrite" }).then(function (picked) {
          return idb("readwrite", function (st) { return st.put(picked, "root"); }).catch(function () {}).then(function () { return picked; });
        });
      })
      .then(function (h) { state.root = h; return h; });
  }

  /* URL（号の HTML の場所など）を、作業フォルダからのパスに直す */
  function relSegments(root, url) {
    var segs = decodeURIComponent(new URL(url, location.href).pathname).split("/").filter(Boolean);
    var idx = segs.lastIndexOf(root.name);
    var starts = idx >= 0 ? [idx + 1] : [];
    for (var i = 0; i < segs.length; i++) { if (starts.indexOf(i) < 0) { starts.push(i); } }
    /* 候補を順に試し、ディレクトリが実在する最初のものを使う */
    function tryAt(k) {
      if (k >= starts.length) { return Promise.reject(new Error("選んだフォルダの中に「" + segs.slice(-2).join("/") + "」が見つかりません。kaiho-studio のフォルダを選び直してください。")); }
      var dirs = segs.slice(starts[k], -1);
      return dirs.reduce(function (p, name) {
        return p.then(function (d) { return d.getDirectoryHandle(name); });
      }, Promise.resolve(root)).then(function (dir) {
        return { dir: dir, name: segs[segs.length - 1], path: segs.slice(starts[k]).join("/") };
      }).catch(function () { return tryAt(k + 1); });
    }
    return tryAt(0);
  }

  function writeTo(root, url, text) {
    return relSegments(root, url).then(function (loc) {
      return loc.dir.getFileHandle(loc.name, { create: true })
        .then(function (fh) { return fh.createWritable(); })
        .then(function (w) { return w.write(text).then(function () { return w.close(); }); })
        .then(function () { return loc.path; });
    });
  }

  function download(name, text, type) {
    var url = URL.createObjectURL(new Blob([text], { type: type }));
    var a = el("a", { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function save() {
    if (!anyDirty()) { showBarToast("保存する変更はありません"); return; }
    syncMeta();
    var jobs = [];
    if (state.dirty.issue) { jobs.push({ kind: "issue", url: location.href, text: serialize(), type: "text/html" }); }
    if (state.dirty.comments) { jobs.push({ kind: "comments", url: new URL(commentsFileName(), location.href).href, text: serializeComments(), type: "text/javascript" }); }
    if (state.dirty.settings) { jobs.push({ kind: "settings", url: new URL(settingsURL(), location.href).href, text: serializeSettings(), type: "text/javascript" }); }

    rootHandle().then(function (root) {
      if (!root) {
        /* 最後の手段。ダウンロードに落とし、手で置き換えてもらう */
        jobs.forEach(function (j) { download(decodeURIComponent(j.url.split("/").pop()), j.text, j.type); state.dirty[j.kind] = false; });
        renderSaveState();
        alert("このブラウザでは直接保存できないため、ダウンロードしました。元のファイルと置き換えてください：\n" +
              jobs.map(function (j) { return "・" + decodeURIComponent(j.url.split("/").pop()); }).join("\n"));
        return;
      }
      return jobs.reduce(function (p, j) {
        return p.then(function (done) {
          return writeTo(root, j.url, j.text).then(function (path) { state.dirty[j.kind] = false; done.push(path); return done; });
        });
      }, Promise.resolve([])).then(function (done) {
        renderSaveState();
        showBarToast("保存しました（" + done.join("、") + "）");
      });
    }).catch(function (e) {
      if (e && e.name === "AbortError") { return; }
      console.error(e);
      alert("保存に失敗しました: " + (e && e.message ? e.message : e));
      renderSaveState();
    });
  }

  /* ==========================================================================
     ツールバー（号・工程・状態だけ、決定 14）と見え方の道具
     ========================================================================== */

  var toastTimer = null;
  function showBarToast(message) {
    var t = $("#kaiho-toast");
    if (!t) { return; }
    t.textContent = message;
    t.setAttribute("data-show", "true");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.setAttribute("data-show", "false"); }, 3200);
  }

  function renderStepBar() {
    var bar = $("#kaiho-steps");
    if (!bar) { return; }
    bar.innerHTML = "";
    var suggested = suggestedStep();
    STEPS.forEach(function (s, i) {
      if (i) { bar.appendChild(el("span", { "class": "step-bar__arrow", "aria-hidden": "true", text: "›" })); }
      var p = stepProgress(s.id);
      bar.appendChild(el("button", {
        type: "button", "class": "step-bar__step",
        "aria-current": state.step === s.id ? "step" : "false",
        "data-done": p.done ? "true" : "false",
        "data-suggested": suggested === s.id ? "true" : "false",
        title: suggested === s.id ? "号の状態から見て、いまはこの工程です" : "",
        onclick: function () { if (document.body.getAttribute("data-settings")) { closeSettings(); } setStep(s.id); }
      }, [
        el("span", { "class": "step-bar__no", text: p.done ? "✓" : String(i + 1) }),
        el("span", { "class": "step-bar__label", text: s.label }),
        el("span", { "class": "step-bar__sub", text: p.text })
      ]));
    });
  }

  function renderUserChip() {
    var chip = $("#kaiho-user");
    if (!chip) { return; }
    chip.innerHTML = "";
    if (state.setupMode) {
      chip.setAttribute("data-setup", "true");
      chip.title = "名簿（" + brandDir() + "settings.js）がまだありません。⚙ 設定の「名簿」で作ると、開くときにログインするようになります";
      chip.appendChild(el("span", { text: "名簿未設定" }));
      chip.appendChild(el("span", { "class": "user-chip__role", "data-role": "editor", text: "編集長として開いています" }));
      return;
    }
    chip.removeAttribute("data-setup");
    chip.appendChild(el("span", { text: state.viewer.name }));
    chip.appendChild(el("span", { "class": "user-chip__role", "data-role": state.viewer.role, text: ROLE_LABELS[state.viewer.role] }));
    chip.appendChild(el("button", { type: "button", text: "ログアウト", onclick: logout }));
  }

  function buildToolbar() {
    var bar = el("div", { "class": "editor-bar", role: "toolbar" }, [
      el("span", { "class": "editor-bar__title", text: "会報スタジオ" }),
      el("span", { "class": "editor-bar__issue", id: "kaiho-issue" }),
      el("span", { "class": "editor-bar__sep" }),
      el("nav", { id: "kaiho-steps", "class": "step-bar", "aria-label": "号の工程" }),
      el("span", { "class": "editor-bar__spacer" }),
      el("button", { id: "kaiho-checkbadge", type: "button", text: "検査",
        title: "検査の指摘（入稿を止めるもの / 判断するもの）。押すとパネルの検査を開く",
        onclick: function () {
          if (document.body.getAttribute("data-settings")) { closeSettings(); }
          setMobileSurface("tasks");
          var d = $("#sec-checks");
          if (d) { d.open = true; d.scrollIntoView({ behavior: "smooth", block: "start" }); }
        } }),
      el("span", { "class": "editor-bar__status kaiho-savestate", role: "status", "aria-live": "polite", "data-dirty": "false", text: "保存済み" }),
      el("button", { type: "button", "class": "save-primary", text: "保存", title: "変更を保存（Ctrl+S）", onclick: save }),
      el("span", { id: "kaiho-toast", role: "status", "aria-live": "polite", "class": "editor-bar__toast", "data-show": "false" }),
      el("span", { "class": "editor-bar__sep" }),
      el("span", { id: "kaiho-user", "class": "user-chip" }),
      el("button", { type: "button", "class": "editor-bar__settings", text: "⚙ 設定",
        title: "テンプレートと名簿（会報ごと）",
        onclick: function () {
          if (document.body.getAttribute("data-settings")) { closeSettings(); } else { openSettings(); }
        } })
    ]);
    document.body.insertBefore(bar, document.body.firstChild);
    observeBarHeight(bar);
  }

  function syncToggles() {
    $$("[data-attr]").forEach(function (b) {
      var on = document.body.getAttribute(b.getAttribute("data-attr")) === b.getAttribute("data-on");
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    /* 台割表示中は見開きを押せないことを見せる（黙って解除しない、決定 4） */
    var spread = $("#kaiho-spread");
    if (spread) { spread.disabled = document.body.getAttribute("data-view") === "plan"; }
  }

  function toggle(id, label, attr, onValue, title) {
    return el("button", {
      id: id, type: "button", title: title || label, text: label,
      "data-attr": attr, "data-on": onValue, "aria-pressed": "false",
      onclick: function () {
        if (document.body.getAttribute(attr) === onValue) { document.body.removeAttribute(attr); }
        else { document.body.setAttribute(attr, onValue); }
        syncToggles();
        checkAll();
        renderShareHandles();
      }
    });
  }

  /* 見え方だけを変える道具は、工程と関係ないので紙面の隅へ */
  function buildViewDock() {
    var zoom = el("select", { id: "kaiho-zoom", title: "紙面の表示サイズ", "aria-label": "紙面の表示サイズ", onchange: function () {
      updateFitZoom();
      renderShareHandles();
    } }, ["fit", "0.5", "0.75", "1", "1.25", "1.5"].map(function (z) {
      return el("option", { value: z, selected: z === "fit" ? "selected" : null, text: z === "fit" ? "画面に合わせる" : Math.round(z * 100) + "%" });
    }));
    document.body.appendChild(el("div", { "class": "view-dock", role: "toolbar", "aria-label": "表示" }, [
      toggle("kaiho-guides", "ガイド", "data-guides", "on", "版面枠と安全域を表示"),
      toggle("kaiho-spread", "見開き", "data-spread", "on", "2ページ並べて表示"),
      zoom
    ]));
  }

  function isCompact() { return window.matchMedia("(max-width: 960px)").matches; }

  function setMobileSurface(surface) {
    document.body.setAttribute("data-surface", surface);
    $$(".mobile-nav button").forEach(function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-surface-target") === surface ? "true" : "false");
    });
    var panel = $(".editor-panel");
    if (panel) { panel.inert = isCompact() && surface === "paper"; }
    updateFitZoom();
  }

  function buildMobileNav() {
    document.body.appendChild(el("nav", { "class": "mobile-nav", "aria-label": "作業内容と紙面の切り替え" }, [
      el("button", { type: "button", "data-surface-target": "tasks", "aria-controls": "kaiho-panel", text: "作業内容",
        onclick: function () { setMobileSurface("tasks"); } }),
      el("button", { type: "button", "data-surface-target": "paper", text: "紙面を見る",
        onclick: function () { setMobileSurface("paper"); } })
    ]));
    setMobileSurface("tasks");
    window.addEventListener("resize", function () {
      setMobileSurface(document.body.getAttribute("data-surface") || "tasks");
      syncToggles();
      renderShareHandles();
    });
  }

  function updateFitZoom() {
    var select = $("#kaiho-zoom");
    if (!select) { return; }
    var zoom = parseFloat(select.value);
    if (select.value === "fit") {
      var sheet = document.body.getAttribute("data-view") === "plan" ? $(".plan-sheet") : $("body > .page");
      if (!sheet) { return; }
      var panelWidth = isCompact() || document.body.hasAttribute("data-settings") ? 0 :
        (parseInt(getComputedStyle(document.documentElement).getPropertyValue("--panel-w"), 10) || PANEL_MIN);
      var columns = !isCompact() && document.body.getAttribute("data-spread") === "on" && sheet.classList.contains("page") ? 2 : 1;
      zoom = Math.min(1, Math.max(0.1, (document.documentElement.clientWidth - panelWidth - (isCompact() ? 32 : 64)) / (sheet.offsetWidth * columns)));
    }
    document.body.style.setProperty("--zoom", String(zoom));
  }

  function revealPaperNode(node, editing) {
    setMobileSurface("paper");
    if (isCompact() && editing) {
      $("#kaiho-zoom").value = "1";
      updateFitZoom();
      showBarToast("青い枠を押して編集。横にスクロールして紙面を見られます。");
    }
    node.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "center", inline: "center" });
    if (editing) {
      var slot = $("[contenteditable=true]", node);
      if (slot) { slot.focus({ preventScroll: true }); }
    }
  }

  /* 決定 5: バーは折り返すので、高さを測って --bar-h に書き戻す */
  function observeBarHeight(bar) {
    function measure() {
      document.documentElement.style.setProperty("--bar-h", bar.offsetHeight + "px");
      updateFitZoom();
    }
    measure();
    if (window.ResizeObserver) { new ResizeObserver(measure).observe(bar); }
    else { window.addEventListener("resize", measure); }
  }

  /* ==========================================================================
     再描画のとりまとめ
     ========================================================================== */

  /* 紙面の記事に「自分の担当か」「書けるか」「未解決コメント数」を印す。
     作業台の印なので serialize() が除去する */
  function markArticles() {
    $$(".page [data-article]").forEach(function (n) {
      var a = articleById(n.getAttribute("data-article"));
      n.setAttribute("data-mine", a && ownsArticle(a) ? "true" : "false");
      n.setAttribute("data-writable", a && canWrite(a) ? "true" : "false");
      var p = ownerArticle(a);
      var c = p ? openCommentCount(p.id) : 0;
      if (c && state.step === "proof") { n.setAttribute("data-comments", String(c)); }
      else { n.removeAttribute("data-comments"); }
    });
  }

  function updateStatusBits() {
    var issue = $("#kaiho-issue");
    if (issue) { issue.textContent = state.meta.issue || ""; }
    renderStepBar();
  }

  function rerenderAll() {
    syncMeta();
    /* 担当者名・続きの付け替えで「誰のページか」が変わるので毎回引き直す */
    applyFocus();
    decoratePages();
    checkAll();
    markArticles();
    if (document.body.getAttribute("data-view") === "plan") { renderPlanSheet(); }
    else { var s = $(".plan-sheet"); if (s) { s.remove(); } }
    renderShareHandles();
    renderPanel();
    updateStatusBits();
    syncToggles();
    renderSaveState();
    updateFitZoom();
  }

  /* ==========================================================================
     起動
     ========================================================================== */

  function start(viewer) {
    state.viewer = viewer;
    document.body.setAttribute("data-role", role());

    buildToolbar();
    buildViewDock();
    buildPanel();
    buildMobileNav();
    renderUserChip();

    document.addEventListener("pointerup", function () { setTimeout(captureSelection, 0); });
    /* タッチ端末の選択ハンドルでも、校正コメントへの引用を拾う。 */
    var selectionTimer;
    document.addEventListener("selectionchange", function () {
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(captureSelection, 150);
    });
    document.addEventListener("keydown", function (ev) {
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === "s" || ev.key === "S")) { ev.preventDefault(); save(); }
    });
    window.addEventListener("beforeunload", function (ev) {
      if (anyDirty()) { ev.preventDefault(); ev.returnValue = ""; }
    });
    /* 印刷直前に検査し、溢れたまま刷る事故を減らす。台割表示中は台割を最新にする */
    window.addEventListener("beforeprint", function () {
      checkAll();
      if (document.body.getAttribute("data-view") === "plan") { renderPlanSheet(); }
    });
    /* 画像の読み込み後にレイアウトが伸びることがあるので、もう一度測る */
    window.addEventListener("load", function () { rerenderAll(); });

    setStep(suggestedStep());
    if (state.setupMode) {
      showBarToast("名簿がまだありません。⚙ 設定の「名簿」で人を登録して保存してください");
    }
  }

  function init() {
    state.meta = readMeta();
    migrateSectionDOM();
    /* 読み込み時の読み替え（旧形式 → 新形式）だけでは「未保存」にしない。
       開いただけで差分が出るのは事故のもと。次に本当に直したときに一緒に書く */
    state.metaText = JSON.stringify(state.meta, null, 2);
    document.documentElement.setAttribute("data-format", state.meta.format || "A4");
    setPanelWidth(PANEL_MIN);

    Promise.all([loadSidecar(settingsURL()), loadSidecar(commentsFileName())]).then(function () {
      state.settings = readSettings();
      state.comments = readComments();
      rebuildTemplates();
      articles().forEach(function (a) { applyShareToDOM(a.id, a.share); });

      if (!members().length) {
        /* 名簿が無い（初期設定前・過去号）。開いた人を編集長として扱う */
        state.setupMode = true;
        start({ name: state.meta.editor.name || "編集長", role: "editor", contact: state.meta.editor.contact || "" });
        return;
      }
      var restored = restoreLogin();
      if (restored) { start(restored); } else { showLogin(start); }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
