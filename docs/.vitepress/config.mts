import { defineConfig } from "vitepress";

// The cubehold documentation site: `pnpm docs` to preview, `pnpm docs:build` for static files.
export default defineConfig({
  title: "cubehold",
  description:
    "Run Minecraft servers on your own computer, a VPS, or your cloud account, from one panel.",
  lang: "en",
  cleanUrls: true,
  lastUpdated: false,
  head: [["link", { rel: "icon", href: "/logo.svg", type: "image/svg+xml" }]],
  themeConfig: {
    logo: "/logo.svg",
    nav: [
      { text: "Guide", link: "/guide/what-is-cubehold" },
      { text: "Install", link: "/guide/install-windows" },
      { text: "Reference", link: "/reference/cli" },
    ],
    sidebar: [
      {
        text: "Start here",
        items: [
          { text: "What is cubehold?", link: "/guide/what-is-cubehold" },
          { text: "Install on Windows", link: "/guide/install-windows" },
          { text: "Install with Docker", link: "/guide/install-docker" },
          { text: "Install on Linux", link: "/guide/install-linux" },
          { text: "Your first server", link: "/guide/first-server" },
        ],
      },
      {
        text: "Playing together",
        items: [
          { text: "Letting friends join", link: "/guide/friends" },
          { text: "Running on a VPS", link: "/guide/vps" },
          { text: "Cloud servers", link: "/guide/cloud" },
        ],
      },
      {
        text: "Running a server",
        items: [
          { text: "Modpacks, mods and plugins", link: "/guide/modpacks" },
          { text: "Backups and schedules", link: "/guide/backups" },
          { text: "Security", link: "/guide/security" },
          { text: "Discord notifications", link: "/guide/notifications" },
          { text: "On your phone", link: "/guide/phone" },
        ],
      },
      {
        text: "Looking after cubehold",
        items: [
          { text: "Updating and uninstalling", link: "/guide/updating" },
          { text: "Troubleshooting", link: "/guide/troubleshooting" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Commands and settings", link: "/reference/cli" },
          { text: "Development", link: "/reference/development" },
        ],
      },
    ],
    search: { provider: "local" },
    outline: { level: [2, 3] },
    footer: { message: "cubehold: a self-hosted Minecraft server manager." },
  },
});
