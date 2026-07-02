import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import "./custom.css";

// The landing hero needs a picture: a concept plate directly under the tagline,
// before the feature cards. Injected via the home-hero-after slot so it only
// renders on the home layout (index.md + zh/index.md). The plate is
// language-neutral (English labels, like the rest of the diagram series).
export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      "home-hero-after": () =>
        h("figure", { class: "plx-hero-figure" }, [
          h("img", {
            src: "/diagrams/plexus-hero.png",
            alt:
              "Plexus describes your heterogeneous resources — notes, calendar, IoT, workspace — as one self-describing capability object an agent can read and invoke, behind an authorize-and-audit boundary.",
          }),
        ]),
    });
  },
};
