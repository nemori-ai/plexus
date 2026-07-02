import { defineConfig } from "vitepress";

// ── shared ────────────────────────────────────────────────────────────────
const description =
  "A local, user-installed capability gateway. Expose your own tools; let an AI agent call them through a default-deny, fully-audited boundary — never by handing over raw keys.";

// ── English nav + sidebar ───────────────────────────────────────────────────
const enNav = [
  { text: "Guide", link: "/guide/", activeMatch: "/guide/" },
  { text: "Concepts", link: "/concepts/", activeMatch: "/concepts/" },
  { text: "Architecture", link: "/architecture/", activeMatch: "/architecture/" },
  { text: "Protocol", link: "/protocol/", activeMatch: "/protocol/" },
  { text: "Extensions", link: "/extensions/", activeMatch: "/extensions/" },
  { text: "For Agents", link: "/agents/", activeMatch: "/agents/" },
];

const enSidebar = {
  "/guide/": [
    {
      text: "Get running",
      items: [
        { text: "From zero", link: "/guide/" },
        { text: "Connect an agent", link: "/guide/connect-an-agent" },
        { text: "Expose a source", link: "/guide/first-party-sources" },
        { text: "Author an extension", link: "/guide/create-an-extension" },
      ],
    },
    { text: "Go deeper", items: [{ text: "The concepts →", link: "/concepts/" }] },
  ],
  "/concepts/": [
    {
      text: "The mental model",
      items: [
        { text: "Read this once", link: "/concepts/" },
        { text: "The trust model", link: "/concepts/trust-model" },
        { text: "The compile model", link: "/concepts/compile-model" },
      ],
    },
  ],
  "/architecture/": [
    {
      text: "How it works inside",
      items: [
        { text: "Overview", link: "/architecture/" },
        { text: "The federated mesh", link: "/architecture/mesh" },
        { text: "The security model", link: "/architecture/security-model" },
      ],
    },
  ],
  "/protocol/": [
    {
      text: "The wire contract",
      items: [{ text: "The protocol", link: "/protocol/" }],
    },
  ],
  "/extensions/": [
    {
      text: "Extending Plexus",
      items: [
        { text: "Authoring guide", link: "/extensions/" },
        { text: "The spec", link: "/extensions/spec" },
      ],
    },
  ],
  "/agents/": [
    { text: "For agents", items: [{ text: "How an agent uses Plexus", link: "/agents/" }] },
  ],
};

// ── 中文 nav + sidebar ───────────────────────────────────────────────────────
const zhNav = [
  { text: "上手", link: "/zh/guide/", activeMatch: "/zh/guide/" },
  { text: "概念", link: "/zh/concepts/", activeMatch: "/zh/concepts/" },
  { text: "架构", link: "/zh/architecture/", activeMatch: "/zh/architecture/" },
  { text: "协议", link: "/zh/protocol/", activeMatch: "/zh/protocol/" },
  { text: "扩展", link: "/zh/extensions/", activeMatch: "/zh/extensions/" },
  { text: "面向 Agent", link: "/zh/agents/", activeMatch: "/zh/agents/" },
];

const zhSidebar = {
  "/zh/guide/": [
    {
      text: "跑起来",
      items: [
        { text: "从零开始", link: "/zh/guide/" },
        { text: "连接一个 agent", link: "/zh/guide/connect-an-agent" },
        { text: "暴露一个源", link: "/zh/guide/first-party-sources" },
        { text: "编写一个扩展", link: "/zh/guide/create-an-extension" },
      ],
    },
    { text: "深入", items: [{ text: "核心概念 →", link: "/zh/concepts/" }] },
  ],
  "/zh/concepts/": [
    {
      text: "心智模型",
      items: [
        { text: "读一遍就通", link: "/zh/concepts/" },
        { text: "信任模型", link: "/zh/concepts/trust-model" },
        { text: "编译模型", link: "/zh/concepts/compile-model" },
      ],
    },
  ],
  "/zh/architecture/": [
    {
      text: "内部怎么工作",
      items: [
        { text: "总览", link: "/zh/architecture/" },
        { text: "联邦网格", link: "/zh/architecture/mesh" },
        { text: "安全模型", link: "/zh/architecture/security-model" },
      ],
    },
  ],
  "/zh/protocol/": [
    {
      text: "线上契约",
      items: [{ text: "协议", link: "/zh/protocol/" }],
    },
  ],
  "/zh/extensions/": [
    {
      text: "扩展 Plexus",
      items: [
        { text: "编写指南", link: "/zh/extensions/" },
        { text: "规范", link: "/zh/extensions/spec" },
      ],
    },
  ],
  "/zh/agents/": [
    { text: "面向 Agent", items: [{ text: "agent 如何使用 Plexus", link: "/zh/agents/" }] },
  ],
};

// ── config ──────────────────────────────────────────────────────────────────
export default defineConfig({
  title: "Plexus",
  description,
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: ["**/*.ctxillu.md", "**/CLAUDE.md", "**/README.md"], // agent/metadata files, not pages
  ignoreDeadLinks: true, // TEMP: pages are still being filled in; tighten before final
  appearance: true, // light + dark toggle (follows system by default) — a doc site is read in daylight too
  head: [
    ["link", { rel: "icon", href: "/favicon.svg" }],
    ["meta", { name: "theme-color", content: "#1a1613" }],
    ["meta", { property: "og:title", content: "Plexus — the capability gateway" }],
    ["meta", { property: "og:description", content: description }],
  ],
  themeConfig: {
    logo: "/logo.svg",
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: "https://github.com/nemori-ai/plexus" }],
  },
  locales: {
    root: {
      label: "English",
      lang: "en",
      themeConfig: {
        nav: enNav,
        sidebar: enSidebar,
        outline: { level: [2, 3], label: "On this page" },
        editLink: {
          pattern: "https://github.com/nemori-ai/plexus/edit/main/site/:path",
          text: "Edit this page on GitHub",
        },
        docFooter: { prev: "Previous", next: "Next" },
      },
    },
    zh: {
      label: "中文",
      lang: "zh-CN",
      link: "/zh/",
      themeConfig: {
        nav: zhNav,
        sidebar: zhSidebar,
        outline: { level: [2, 3], label: "本页导航" },
        editLink: {
          pattern: "https://github.com/nemori-ai/plexus/edit/main/site/:path",
          text: "在 GitHub 上编辑此页",
        },
        docFooter: { prev: "上一篇", next: "下一篇" },
        darkModeSwitchLabel: "外观",
        returnToTopLabel: "返回顶部",
        langMenuLabel: "语言",
      },
    },
  },
});
