import DefaultTheme from "vitepress/theme";
import { h, onMounted, watch, nextTick } from "vue";
import { useRoute } from "vitepress";
import mediumZoom from "medium-zoom";
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
  setup() {
    // Click-to-zoom on every content image (medium-zoom). The guide screenshots
    // are full-console captures — unreadable at column width — so a click blows
    // them up to viewport size. Re-attach on route change (SPA navigation).
    const route = useRoute();
    const initZoom = () => {
      mediumZoom(".vp-doc img", { margin: 16, background: "var(--vp-c-bg)" });
    };
    onMounted(initZoom);
    watch(
      () => route.path,
      () => nextTick(initZoom),
    );
  },
};
