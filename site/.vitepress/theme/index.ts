import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import RealtimeDemo from "./RealtimeDemo.vue";
import GetStartedSelector from "./GetStartedSelector.vue";
import "./custom.css";

// The landing centerpiece: the simulated Realtime monitor ("Watch it govern") —
// a scripted ~66 s loop of the admin monitor's exact event shapes, injected via
// the home-hero-after slot so it renders only on the home layout (index.md +
// zh/index.md). RealtimeDemo reads the locale itself. (It replaced PlexusHero,
// which is kept unmounted for a possible concepts-page revival.)
export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      "home-hero-after": () => h(RealtimeDemo),
    });
  },
  enhanceApp({ app }) {
    // The PyTorch-style "pick your setup → paste-into-your-agent" selector, usable
    // in any guide page as <GetStartedSelector /> (or with :scenario to lock the row).
    app.component("GetStartedSelector", GetStartedSelector);
  },
};
