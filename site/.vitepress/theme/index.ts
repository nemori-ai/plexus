import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import PlexusHero from "./PlexusHero.vue";
import "./custom.css";

// The landing hero: an animated "scatter → resolve" plate + the four pillars as
// an interactive strip, injected via the home-hero-after slot so it renders only
// on the home layout (index.md + zh/index.md). PlexusHero reads the locale itself.
export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      "home-hero-after": () => h(PlexusHero),
    });
  },
};
